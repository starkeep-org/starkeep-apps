import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encodeEmbedding, normalize } from "@/vision/embeddings";
import { SCENE_EMBEDDING_DIM, SCENE_MODEL_ID } from "@/vision/models";
import { sceneIndexPath } from "@/vision/paths";
import {
  buildSceneIndex,
  deleteSceneIndex,
  readSceneIndex,
  scoreAgainstIndex,
} from "@/vision/scene-index";
import { readSceneSidecar, writeTaskSidecar } from "@/vision/sidecars";
import { SCENE_SIDECAR_VERSION, type SceneSidecar } from "@/vision/types";

/**
 * The compacted scene index.
 *
 * Its contract is unusual and worth testing directly: it is **derived and
 * disposable**, so almost every way it can be wrong must resolve to "rebuild",
 * not "throw". The rejection paths below are therefore the substance — an index
 * that half-loads is worse than none, because it ranks against a truncated store
 * without saying so.
 *
 * The model-id check is the one that matters most. Embeddings from a different
 * tower are the right shape and the wrong space, so ranking against them yields
 * plausible ordered nonsense rather than an error.
 */

let root: string;
let previousDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "starkeep-scene-index-"));
  previousDir = process.env.STARKEEP_DIR;
  process.env.STARKEEP_DIR = root;
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.STARKEEP_DIR;
  else process.env.STARKEEP_DIR = previousDir;
  rmSync(root, { recursive: true, force: true });
});

/** A unit vector pointing along axis `axis` of the real embedding space. */
function unitAt(axis: number): Float32Array {
  const v = new Float32Array(SCENE_EMBEDDING_DIM);
  v[axis % SCENE_EMBEDDING_DIM] = 1;
  return v;
}

function seedScene(recordId: string, vector: Float32Array, overrides: Partial<SceneSidecar> = {}) {
  const sidecar: SceneSidecar = {
    v: SCENE_SIDECAR_VERSION,
    model: SCENE_MODEL_ID,
    processedAt: "2026-07-29T00:00:00.000Z",
    w: 640,
    h: 480,
    embedding: encodeEmbedding(vector),
    ...overrides,
  };
  writeTaskSidecar("scene", recordId, sidecar);
}

/** Overwrite the index file with arbitrary bytes, creating the directory. */
function corruptIndexWith(bytes: Buffer): void {
  mkdirSync(dirname(sceneIndexPath()), { recursive: true });
  writeFileSync(sceneIndexPath(), bytes);
}

describe("scene sidecars", () => {
  it("round-trips an embedding and reports its own staleness", () => {
    seedScene("a", unitAt(0));
    expect(readSceneSidecar("a")).toMatchObject({ w: 640, h: 480 });

    // Per-task staleness: a scene sidecar from another tower is not current, and
    // that is independent of anything the face task has done.
    seedScene("stale", unitAt(1), { model: "some-other-tower" });
    expect(readSceneSidecar("stale")).toBeNull();
  });

  it("rejects a sidecar with no embedding rather than reading it as processed", () => {
    writeTaskSidecar("scene", "empty", {
      v: SCENE_SIDECAR_VERSION,
      model: SCENE_MODEL_ID,
      processedAt: "2026-07-29T00:00:00.000Z",
      w: 1,
      h: 1,
    });
    expect(readSceneSidecar("empty")).toBeNull();
  });
});

describe("buildSceneIndex", () => {
  it("writes a valid empty index when nothing has been scanned", () => {
    // Not the same as "no index": an empty built index means the fold ran and
    // found nothing, which is a legitimate end-of-pass outcome.
    expect(buildSceneIndex()).toBe(0);
    const index = readSceneIndex();
    expect(index).not.toBeNull();
    expect(index!.recordIds).toEqual([]);
    expect(index!.vectors.length).toBe(0);
  });

  it("round-trips every current sidecar, row order matching the id table", () => {
    seedScene("a", unitAt(0));
    seedScene("b", unitAt(1));
    seedScene("c", unitAt(2));
    expect(buildSceneIndex()).toBe(3);

    const index = readSceneIndex()!;
    expect(index.dim).toBe(SCENE_EMBEDDING_DIM);
    expect(index.modelId).toBe(SCENE_MODEL_ID);
    expect([...index.recordIds].sort()).toEqual(["a", "b", "c"]);
    expect(index.vectors.length).toBe(3 * SCENE_EMBEDDING_DIM);

    // Row i really is recordIds[i]'s vector — an off-by-one here would rank every
    // photo under its neighbour's embedding and never throw.
    for (let row = 0; row < index.recordIds.length; row++) {
      const stored = readSceneSidecar(index.recordIds[row])!;
      const expected = Buffer.from(stored.embedding, "base64");
      for (let i = 0; i < index.dim; i++) {
        expect(index.vectors[row * index.dim + i]).toBeCloseTo(expected.readFloatLE(i * 4), 6);
      }
    }
  });

  it("leaves out stale-model and undecodable sidecars without failing the build", () => {
    seedScene("good", unitAt(0));
    seedScene("stale", unitAt(1), { model: "some-other-tower" });
    seedScene("wrong-dim", new Float32Array(8));
    writeTaskSidecar("scene", "garbage", {
      v: SCENE_SIDECAR_VERSION,
      model: SCENE_MODEL_ID,
      processedAt: "2026-07-29T00:00:00.000Z",
      w: 1,
      h: 1,
      embedding: "not-base64-float32!!!",
    } as SceneSidecar);

    expect(buildSceneIndex()).toBe(1);
    expect(readSceneIndex()!.recordIds).toEqual(["good"]);
  });

  it("rebuilds from scratch, dropping rows whose sidecars went away", () => {
    seedScene("a", unitAt(0));
    seedScene("b", unitAt(1));
    expect(buildSceneIndex()).toBe(2);

    rmSync(join(root, "app-local", "photos", "vision", "scene", "b.json"));
    expect(buildSceneIndex()).toBe(1);
    expect(readSceneIndex()!.recordIds).toEqual(["a"]);
  });
});

describe("readSceneIndex rejects rather than throws", () => {
  it("returns null when there is no index at all", () => {
    expect(readSceneIndex()).toBeNull();
  });

  it("returns null after a delete", () => {
    seedScene("a", unitAt(0));
    buildSceneIndex();
    deleteSceneIndex();
    expect(readSceneIndex()).toBeNull();
    // Deleting a missing index is a no-op, not an error — it runs on every reap.
    expect(() => deleteSceneIndex()).not.toThrow();
  });

  it("returns null for a file that is not an index", () => {
    corruptIndexWith(Buffer.from("this is not an index file, but it is long enough"));
    expect(readSceneIndex()).toBeNull();
  });

  it("returns null for a file too short to hold a preamble", () => {
    corruptIndexWith(Buffer.from([1, 2, 3]));
    expect(readSceneIndex()).toBeNull();
  });

  it("returns null for a truncated vector block", () => {
    seedScene("a", unitAt(0));
    seedScene("b", unitAt(1));
    buildSceneIndex();
    const whole = readFileSync(sceneIndexPath());
    // Losing the tail must not read as "one row" — the id table still claims two.
    corruptIndexWith(whole.subarray(0, whole.byteLength - 4));
    expect(readSceneIndex()).toBeNull();
  });

  it("returns null for an index built by a different model", () => {
    // The important one. A wrong-tower index has the right shape and the wrong
    // space, so it would rank silently rather than fail.
    seedScene("a", unitAt(0));
    buildSceneIndex();
    const whole = readFileSync(sceneIndexPath());
    const headerLength = whole.readUInt32LE(8);
    const header = JSON.parse(whole.subarray(12, 12 + headerLength).toString("utf-8"));
    header.modelId = "siglip2-so400m-patch16-384:vision-int8";
    const rebuilt = Buffer.from(JSON.stringify(header), "utf-8");
    const preamble = Buffer.alloc(12);
    whole.copy(preamble, 0, 0, 12);
    preamble.writeUInt32LE(rebuilt.byteLength, 8);
    corruptIndexWith(
      Buffer.concat([preamble, rebuilt, whole.subarray(12 + headerLength)]),
    );
    expect(readSceneIndex()).toBeNull();
  });

  it("returns null for an unparseable header", () => {
    seedScene("a", unitAt(0));
    buildSceneIndex();
    const whole = readFileSync(sceneIndexPath());
    const headerLength = whole.readUInt32LE(8);
    const broken = Buffer.alloc(headerLength, 0x7b); // '{' repeated
    corruptIndexWith(
      Buffer.concat([whole.subarray(0, 12), broken, whole.subarray(12 + headerLength)]),
    );
    expect(readSceneIndex()).toBeNull();
  });
});

describe("scoreAgainstIndex", () => {
  it("ranks by cosine, descending, over every row", () => {
    // Deliberately returns the whole pool rather than a top-k: §5.1 min-max
    // normalizes the dense score across the pool for this query, and §5.3 rejects
    // an absolute threshold outright.
    seedScene("aligned", unitAt(0));
    seedScene("orthogonal", unitAt(1));
    seedScene("between", normalize(Float32Array.from(unitAt(0), (v, i) => v + unitAt(1)[i])));
    buildSceneIndex();

    const scored = scoreAgainstIndex(readSceneIndex()!, unitAt(0));
    expect(scored.length).toBe(3);
    expect(scored.map(([id]) => id)).toEqual(["aligned", "between", "orthogonal"]);
    expect(scored[0][1]).toBeCloseTo(1, 5);
    expect(scored[1][1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(scored[2][1]).toBeCloseTo(0, 5);
  });

  it("scores an empty index as an empty pool", () => {
    buildSceneIndex();
    expect(scoreAgainstIndex(readSceneIndex()!, unitAt(0))).toEqual([]);
  });

  it("throws on a query of the wrong dimension", () => {
    // The one case that is a programming error rather than a stale file: a query
    // vector from the wrong tower cannot be salvaged by rebuilding anything.
    seedScene("a", unitAt(0));
    buildSceneIndex();
    expect(() => scoreAgainstIndex(readSceneIndex()!, new Float32Array(512))).toThrow(/512-d/);
  });
});
