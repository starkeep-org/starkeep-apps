import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FACE_DETECTOR_MODEL,
  FACE_EMBEDDER_MODEL,
  FACE_MODEL_ID,
  FACE_MODELS,
  faceModelStatus,
} from "@/vision/models";
import { modelsDir } from "@/vision/paths";
import { DigestMismatchError, verifiedDownload } from "../scripts/lib/verified-download";

/**
 * Model installation and integrity.
 *
 * `faceModelStatus` decides whether the feature is offered at all, and it judges
 * by **size** rather than digest — re-hashing 278 MB on every status poll would
 * make the Settings panel unusable. That is only safe because the digest is
 * checked once, at download, and a failed check leaves nothing behind. Both
 * halves are pinned here; either alone lets a truncated file present as a
 * working model.
 */

let root: string;
let previousDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "starkeep-models-"));
  previousDir = process.env.STARKEEP_DIR;
  process.env.STARKEEP_DIR = root;
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.STARKEEP_DIR;
  else process.env.STARKEEP_DIR = previousDir;
  rmSync(root, { recursive: true, force: true });
});

describe("the model manifest", () => {
  it("fetches only the two graphs the face task uses", () => {
    // antelopev2 ships five; `1k3d68` alone is another 144 MB we would never
    // call.
    expect(FACE_MODELS).toHaveLength(2);
    expect(FACE_MODELS.map((m) => m.fileName).sort()).toEqual([
      "glintr100.onnx",
      "scrfd_10g_bnkps.onnx",
    ]);
  });

  it("pins each URL to a commit rather than a branch", () => {
    // "Same URL, same bytes" independently of the digest check. `main` would
    // make the pinned SHA-256 a tripwire rather than a guarantee.
    for (const model of FACE_MODELS) {
      expect(model.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
      expect(model.url).not.toContain("/resolve/main/");
    }
  });

  it("declares a full-length SHA-256 for each file", () => {
    for (const model of FACE_MODELS) {
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.sizeBytes).toBeGreaterThan(0);
    }
  });

  it("names both graphs in the sidecar's model id", () => {
    // A sidecar whose `model` does not match is reprocessed. Swapping in the
    // lighter pair later has to invalidate old results, and it can only do that
    // if the id actually identifies the pair.
    expect(FACE_MODEL_ID).toContain("scrfd_10g_bnkps");
    expect(FACE_MODEL_ID).toContain("glintr100");
  });
});

describe("faceModelStatus", () => {
  it("reports both missing before anything is fetched", () => {
    const status = faceModelStatus();
    expect(status.installed).toBe(false);
    expect(status.missing.sort()).toEqual(["glintr100.onnx", "scrfd_10g_bnkps.onnx"]);
  });

  it("reports installed once both files are present at the right size", () => {
    mkdirSync(modelsDir(), { recursive: true });
    for (const model of FACE_MODELS) {
      writeFileSync(join(modelsDir(), model.fileName), Buffer.alloc(model.sizeBytes));
    }
    expect(faceModelStatus()).toMatchObject({ installed: true, missing: [] });
  });

  it("reports a truncated file as missing, not installed", () => {
    // The failure this prevents: an interrupted download presenting as a model,
    // and surfacing as an opaque ONNX load error in the middle of a scan.
    mkdirSync(modelsDir(), { recursive: true });
    writeFileSync(
      join(modelsDir(), FACE_DETECTOR_MODEL.fileName),
      Buffer.alloc(FACE_DETECTOR_MODEL.sizeBytes),
    );
    writeFileSync(join(modelsDir(), FACE_EMBEDDER_MODEL.fileName), Buffer.alloc(1024));

    const status = faceModelStatus();
    expect(status.installed).toBe(false);
    expect(status.missing).toEqual([FACE_EMBEDDER_MODEL.fileName]);
  });

  it("names the directory the files belong in", () => {
    expect(faceModelStatus().dir).toBe(modelsDir());
    expect(faceModelStatus().dir).toContain(join("app-local", "photos", "vision"));
  });
});

describe("verifiedDownload", () => {
  const bytes = Buffer.from("some model weights, pretend these are 261 MB");
  const digest = createHash("sha256").update(bytes).digest("hex");

  /** A `fetch` that serves `body` once. */
  const serving = (body: Buffer, status = 200) =>
    (async () =>
      new Response(status === 200 ? new Uint8Array(body) : null, {
        status,
        statusText: status === 200 ? "OK" : "Not Found",
      })) as unknown as typeof fetch;

  it("writes the file when the digest matches", async () => {
    const target = join(root, "model.onnx");
    const returned = await verifiedDownload({
      url: "https://example.invalid/model.onnx",
      target,
      sha256: digest,
      fetchImpl: serving(bytes),
    });
    expect(returned).toBe(digest);
    expect(readFileSync(target)).toEqual(bytes);
  });

  it("throws and leaves nothing behind when the digest does not match", async () => {
    // The property the size-based status check depends on. A partial file that
    // survived a failed verify would be picked up as installed later.
    const target = join(root, "model.onnx");
    await expect(
      verifiedDownload({
        url: "https://example.invalid/model.onnx",
        target,
        sha256: "0".repeat(64),
        fetchImpl: serving(bytes),
      }),
    ).rejects.toBeInstanceOf(DigestMismatchError);

    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.download`)).toBe(false);
  });

  it("reports both digests so a mismatch is diagnosable", async () => {
    const target = join(root, "model.onnx");
    const err = await verifiedDownload({
      url: "https://example.invalid/model.onnx",
      target,
      sha256: "1".repeat(64),
      fetchImpl: serving(bytes),
    }).then(
      () => null,
      (e: unknown) => e as DigestMismatchError,
    );

    expect(err).toBeInstanceOf(DigestMismatchError);
    expect(err!.expected).toBe("1".repeat(64));
    expect(err!.actual).toBe(digest);
    expect(err!.message).toContain(digest);
  });

  it("does not append to a leftover partial download", async () => {
    // An interrupted run leaves `.download` behind. Appending to it would make
    // every retry fail the digest check, on a file the user cannot see, with an
    // error that says the download is corrupt rather than that the leftover is.
    const target = join(root, "model.onnx");
    writeFileSync(`${target}.download`, Buffer.from("leftover garbage"));

    await verifiedDownload({
      url: "https://example.invalid/model.onnx",
      target,
      sha256: digest,
      fetchImpl: serving(bytes),
    });
    expect(readFileSync(target)).toEqual(bytes);
  });

  it("surfaces a failed request rather than writing an empty file", async () => {
    const target = join(root, "model.onnx");
    await expect(
      verifiedDownload({
        url: "https://example.invalid/model.onnx",
        target,
        sha256: digest,
        fetchImpl: serving(Buffer.alloc(0), 404),
      }),
    ).rejects.toThrow(/404/);
    expect(existsSync(target)).toBe(false);
  });

  it("reports progress as bytes arrive", async () => {
    const target = join(root, "model.onnx");
    const seen: number[] = [];
    await verifiedDownload({
      url: "https://example.invalid/model.onnx",
      target,
      sha256: digest,
      onProgress: (n) => seen.push(n),
      fetchImpl: serving(bytes),
    });
    expect(seen.at(-1)).toBe(bytes.byteLength);
  });
});
