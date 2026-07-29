/**
 * The compacted scene embedding index — one binary file of vectors plus a
 * record-id table, rebuilt at the end of a scan.
 *
 * Exists because of a specific asymmetry (plan §5.5): folding the whole sidecar
 * store is fine *once* at end-of-pass and far too slow *per query*. 10 k JSON
 * files is 10 k `open`/`read`/`parse` cycles and a base64 decode each; the same
 * data as one contiguous `Float32Array` is a single read and a linear dot-product
 * scan measured in milliseconds. At 1152 dims that is ~46 MB for 10 k photos —
 * which is why there is still no vector database, no ANN index, and no HNSW here.
 *
 * **Derived and disposable.** Sidecars stay authoritative. A missing, truncated,
 * or stale-model index is not an error state to repair: it rebuilds. That is why
 * every read path returns `null` rather than throwing, and why the header carries
 * the model id — an index built by a different tower must not be ranked against,
 * and silently mixing precisions is exactly the failure this prevents.
 *
 * No ONNX here: this is app-server-safe and read by the query worker alike.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decodeEmbedding } from "./embeddings";
import { SCENE_EMBEDDING_DIM, SCENE_MODEL_ID } from "./models";
import { sceneIndexPath } from "./paths";
import { isCurrentFor, listTaskRecordIds, readTaskSidecar } from "./sidecars";
import type { SceneSidecar } from "./types";

/** `"SKVI"` — Starkeep vision index. Guards against reading an unrelated file. */
const MAGIC = 0x534b5649;
/**
 * Bumped when the *file layout* changes, independently of the model id. A reader
 * that cannot parse the container must not try to interpret the header inside it.
 */
const INDEX_FORMAT_VERSION = 1;

/** `[magic, formatVersion, headerLength]`, then JSON header, then the vectors. */
const PREAMBLE_BYTES = 12;

interface IndexHeader {
  modelId: string;
  dim: number;
  /** Row order of the embedding block. Row `i` belongs to `recordIds[i]`. */
  recordIds: string[];
}

export interface SceneIndex {
  modelId: string;
  dim: number;
  recordIds: string[];
  /** `recordIds.length × dim`, row-major, every row L2-normalized. */
  vectors: Float32Array;
}

/**
 * Fold every current scene sidecar into one file.
 *
 * Written via a temp file and `rename` like the sidecars themselves: a scan can
 * be killed mid-write, and a half-written index that still parses is worse than
 * none, because it would rank against a truncated store without saying so.
 *
 * Returns how many rows it wrote. Zero is a legitimate outcome (scene enabled,
 * nothing scanned yet) and still writes a valid empty index, so "no index" keeps
 * meaning "never built" rather than "built over nothing".
 */
export function buildSceneIndex(): number {
  const recordIds: string[] = [];
  const rows: Float32Array[] = [];

  for (const id of listTaskRecordIds("scene")) {
    const sidecar = readTaskSidecar("scene", id) as SceneSidecar | null;
    if (!sidecar || !isCurrentFor("scene", sidecar)) continue;
    let vector: Float32Array;
    try {
      vector = decodeEmbedding(sidecar.embedding);
    } catch {
      // A sidecar whose embedding will not decode is a sidecar to leave out, not
      // a reason to abandon the index. The next scan rewrites it.
      continue;
    }
    if (vector.length !== SCENE_EMBEDDING_DIM) continue;
    recordIds.push(id);
    rows.push(vector);
  }

  const header: IndexHeader = {
    modelId: SCENE_MODEL_ID,
    dim: SCENE_EMBEDDING_DIM,
    recordIds,
  };
  const headerJson = Buffer.from(JSON.stringify(header), "utf-8");

  const preamble = Buffer.alloc(PREAMBLE_BYTES);
  preamble.writeUInt32LE(MAGIC, 0);
  preamble.writeUInt32LE(INDEX_FORMAT_VERSION, 4);
  preamble.writeUInt32LE(headerJson.byteLength, 8);

  const block = new Float32Array(rows.length * SCENE_EMBEDDING_DIM);
  for (let i = 0; i < rows.length; i++) block.set(rows[i], i * SCENE_EMBEDDING_DIM);

  const path = sceneIndexPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    Buffer.concat([
      preamble,
      headerJson,
      Buffer.from(block.buffer, block.byteOffset, block.byteLength),
    ]),
  );
  renameSync(tmp, path);
  return recordIds.length;
}

/**
 * Read the index, or `null` if there is nothing usable there.
 *
 * Every rejection is a rebuild trigger, never an exception: absent, too short,
 * wrong magic, unknown layout version, unparseable header, wrong dimension,
 * truncated vector block, or — the important one — **built by a different
 * model**. Ranking a query against embeddings from another tower produces
 * plausible ordered nonsense, and it is exactly the sort of thing that would
 * survive review.
 */
export function readSceneIndex(): SceneIndex | null {
  let buf: Buffer;
  try {
    buf = readFileSync(sceneIndexPath());
  } catch {
    return null;
  }
  if (buf.byteLength < PREAMBLE_BYTES) return null;
  if (buf.readUInt32LE(0) !== MAGIC) return null;
  if (buf.readUInt32LE(4) !== INDEX_FORMAT_VERSION) return null;

  const headerLength = buf.readUInt32LE(8);
  const vectorsAt = PREAMBLE_BYTES + headerLength;
  if (buf.byteLength < vectorsAt) return null;

  let header: IndexHeader;
  try {
    header = JSON.parse(buf.subarray(PREAMBLE_BYTES, vectorsAt).toString("utf-8")) as IndexHeader;
  } catch {
    return null;
  }
  if (header.modelId !== SCENE_MODEL_ID) return null;
  if (header.dim !== SCENE_EMBEDDING_DIM) return null;
  if (!Array.isArray(header.recordIds)) return null;

  const expected = header.recordIds.length * header.dim * 4;
  if (buf.byteLength - vectorsAt !== expected) return null;

  // Copied rather than viewed: `Float32Array` requires 4-byte alignment and the
  // header length puts the block at an arbitrary offset. Same reasoning as
  // `decodeEmbedding`.
  const vectors = new Float32Array(header.recordIds.length * header.dim);
  for (let i = 0; i < vectors.length; i++) vectors[i] = buf.readFloatLE(vectorsAt + i * 4);

  return { modelId: header.modelId, dim: header.dim, recordIds: header.recordIds, vectors };
}

export function deleteSceneIndex(): void {
  rmSync(sceneIndexPath(), { force: true });
}

/**
 * Cosine of `query` against every row, as `[recordId, score]` sorted descending.
 *
 * A plain linear scan, and at this scale that is the whole design: rows and the
 * query are both unit vectors, so cosine is a dot product. Deliberately returns
 * *every* row rather than a top-k — §5.1 min-max normalizes the dense score
 * across the result pool for this query, which needs the pool, and §5.3 rejects
 * an absolute threshold outright.
 */
export function scoreAgainstIndex(index: SceneIndex, query: Float32Array): Array<[string, number]> {
  if (query.length !== index.dim) {
    throw new Error(`query is ${query.length}-d, index is ${index.dim}-d`);
  }
  const out: Array<[string, number]> = [];
  for (let row = 0; row < index.recordIds.length; row++) {
    const base = row * index.dim;
    let dot = 0;
    for (let i = 0; i < index.dim; i++) dot += index.vectors[base + i] * query[i];
    out.push([index.recordIds[row], dot]);
  }
  out.sort((a, b) => b[1] - a[1]);
  return out;
}
