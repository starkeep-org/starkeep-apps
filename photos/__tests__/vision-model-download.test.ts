import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACK_FILE } from "@/vision/licence";
import { modelDownloadState, startModelDownload } from "@/vision/model-download";
import { FACE_DETECTOR_MODEL, FACE_EMBEDDER_MODEL, faceModelStatus } from "@/vision/models";
import { modelsDir } from "@/vision/paths";

import { POST as modelsPost } from "../app/api/vision/models/route";

/**
 * The in-app model download.
 *
 * What matters here is not that bytes move — `verifiedDownload` is pinned in
 * `vision-models.test.ts` — but the things a button-driven download can get
 * wrong that a shell script could not: starting without an acceptance on record,
 * fetching what is already on disk, two clicks starting two transfers, and a
 * failure leaving something that later reads as installed.
 *
 * The injected `fetch` serves bytes that cannot hash to the pinned digests — no
 * test can produce 261 MB of the real ones — so every transfer here ends in a
 * mismatch. That is the interesting end anyway: it is the state where something
 * partial could survive. `verifiedDownload`'s success path is pinned separately
 * in `vision-models.test.ts`.
 */

let root: string;
let previousDir: string | undefined;

function resetDownloader(): void {
  const key = Symbol.for("starkeep.photos.vision.modelDownload");
  delete (globalThis as unknown as Record<symbol, unknown>)[key];
}

/** A `fetch` that serves `body` for every request. */
const serving = (body: Buffer) =>
  (async () =>
    new Response(new Uint8Array(body), { status: 200, statusText: "OK" })) as unknown as typeof fetch;

/** Waits for the background transfer to settle. */
async function settled(): Promise<void> {
  for (let i = 0; i < 200 && modelDownloadState().running; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(modelDownloadState().running).toBe(false);
}

/** Writes a file of the manifest's exact size, which is what "installed" means. */
function installModel(model: { fileName: string; sizeBytes: number }): void {
  mkdirSync(modelsDir(), { recursive: true });
  writeFileSync(join(modelsDir(), model.fileName), Buffer.alloc(model.sizeBytes));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "starkeep-model-download-"));
  previousDir = process.env.STARKEEP_DIR;
  process.env.STARKEEP_DIR = root;
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  delete process.env.NEXT_PUBLIC_FORCE_REMOTE;
  resetDownloader();
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.STARKEEP_DIR;
  else process.env.STARKEEP_DIR = previousDir;
  rmSync(root, { recursive: true, force: true });
});

describe("startModelDownload", () => {
  it("quotes the bytes it is about to move, not the size of the full pair", async () => {
    // The detector is already there, so only the embedder is owed. A total that
    // included it would make the progress bar stall at 6% and never finish.
    installModel(FACE_DETECTOR_MODEL);
    const result = startModelDownload({ fetchImpl: serving(Buffer.from("wrong bytes")) });

    expect(result.ok).toBe(true);
    expect(modelDownloadState().bytesTotal).toBe(FACE_EMBEDDER_MODEL.sizeBytes);
    await settled();
  });

  it("records the licence acceptance before the bytes land", async () => {
    // Recorded up front so an interrupted download still leaves evidence of what
    // was agreed to — the agreement is to the terms, not to a completed file.
    const result = startModelDownload({ fetchImpl: serving(Buffer.from("wrong bytes")) });
    expect(result.ok).toBe(true);

    const ack = readFileSync(join(modelsDir(), ACK_FILE), "utf-8");
    expect(ack).toContain("non-commercial research use only");
    expect(ack).toContain("Faces panel");
    await settled();
  });

  it("refuses a second transfer while one is running", async () => {
    const first = startModelDownload({ fetchImpl: serving(Buffer.from("wrong bytes")) });
    expect(first.ok).toBe(true);

    // Double-click, or two tabs. Two transfers writing the same `.download`
    // temporary would fail each other's digest check.
    const second = startModelDownload({ fetchImpl: serving(Buffer.from("wrong bytes")) });
    expect(second).toMatchObject({ ok: false, status: 409 });

    await settled();
  });

  it("refuses when both models are already installed", () => {
    installModel(FACE_DETECTOR_MODEL);
    installModel(FACE_EMBEDDER_MODEL);
    expect(startModelDownload()).toMatchObject({ ok: false, status: 409 });
    expect(modelDownloadState().running).toBe(false);
  });

  it("reports a failure and leaves nothing that reads as installed", async () => {
    // The bytes served do not hash to the pinned digest, which is the same shape
    // as a truncated transfer or a tampered mirror.
    startModelDownload({ fetchImpl: serving(Buffer.from("not the model")) });
    await settled();

    const state = modelDownloadState();
    expect(state.error).toMatch(/SHA-256 mismatch/);
    expect(state.currentFile).toBeNull();
    expect(state.finishedAt).not.toBeNull();

    expect(faceModelStatus().installed).toBe(false);
    expect(existsSync(join(modelsDir(), FACE_DETECTOR_MODEL.fileName))).toBe(false);
    expect(existsSync(join(modelsDir(), `${FACE_DETECTOR_MODEL.fileName}.download`))).toBe(false);
  });

  it("is startable again after a failure", async () => {
    startModelDownload({ fetchImpl: serving(Buffer.from("not the model")) });
    await settled();
    expect(modelDownloadState().error).not.toBeNull();

    // The retry the panel's "Try again" offers: a failed run must not latch.
    const retry = startModelDownload({ fetchImpl: serving(Buffer.from("still not the model")) });
    expect(retry.ok).toBe(true);
    expect(modelDownloadState().error).toBeNull();
    await settled();
  });

  it("stops after the first failure rather than trying the rest", async () => {
    // Both files come from the same mirror at the same commit. If the first
    // fails the digest check, the second is not going to be fine, and 261 MB of
    // "let's see" is not a reasonable response to a corrupt 17 MB.
    startModelDownload({ fetchImpl: serving(Buffer.from("not the model")) });
    await settled();

    // The mismatch names the file it was writing; the second model never got a
    // turn.
    expect(modelDownloadState().error).toContain(FACE_DETECTOR_MODEL.fileName);
    expect(modelDownloadState().error).not.toContain(FACE_EMBEDDER_MODEL.fileName);
    expect(existsSync(join(modelsDir(), FACE_EMBEDDER_MODEL.fileName))).toBe(false);
  });
});

describe("POST /api/vision/models", () => {
  const post = (body: unknown) =>
    modelsPost(
      new Request("http://localhost/api/vision/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }) as never,
    );

  it("refuses a download that does not accept the licence", async () => {
    // The reason a button may fetch non-commercial-research-only weights at all
    // is that the button says so. A request without the flag is a caller that
    // never showed anyone the terms.
    const res = await post({ action: "download" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("acceptLicence");
    expect(modelDownloadState().running).toBe(false);
    expect(existsSync(join(modelsDir(), ACK_FILE))).toBe(false);
  });

  it("refuses acceptLicence sent as a truthy non-true value", async () => {
    const res = await post({ action: "download", acceptLicence: "yes" });
    expect(res.status).toBe(400);
    expect(modelDownloadState().running).toBe(false);
  });

  it("rejects an unknown action", async () => {
    const res = await post({ action: "cancel", acceptLicence: true });
    expect(res.status).toBe(400);
    expect(modelDownloadState().running).toBe(false);
  });

  it("answers 501 against a remote data server, without touching disk", async () => {
    process.env.NEXT_PUBLIC_FORCE_REMOTE = "true";
    const res = await post({ action: "download", acceptLicence: true });
    expect(res.status).toBe(501);
    expect(modelDownloadState().running).toBe(false);
    expect(existsSync(modelsDir())).toBe(false);
  });
});
