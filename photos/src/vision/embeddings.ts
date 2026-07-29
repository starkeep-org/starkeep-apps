/**
 * How a 512-d identity vector travels between the worker, the sidecar files, and
 * the People view.
 *
 * Base64 of little-endian float32 — 683 bytes per face rather than the ~4 KB a
 * JSON number array costs, and lossless, which a rounded decimal encoding would
 * not be at the fourth decimal place where a 0.45 cosine threshold lives.
 *
 * No ONNX here: this is the boundary the engine's output crosses to reach code
 * that must stay in the Next server graph.
 */

/** Little-endian on every platform starkeep targets; asserted rather than assumed. */
function assertLittleEndian(): void {
  const probe = new Uint8Array(new Uint16Array([1]).buffer);
  if (probe[0] !== 1) {
    throw new Error("vision embeddings assume a little-endian host");
  }
}

export function encodeEmbedding(vector: Float32Array): string {
  assertLittleEndian();
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
}

export function decodeEmbedding(encoded: string): Float32Array {
  assertLittleEndian();
  const buf = Buffer.from(encoded, "base64");
  if (buf.byteLength % 4 !== 0) {
    throw new Error(`embedding is ${buf.byteLength} bytes — not a whole number of float32s`);
  }
  // Copied, not viewed: `Buffer.from(base64)` may sit at a non-zero offset in a
  // pooled ArrayBuffer, and Float32Array requires 4-byte alignment.
  const out = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/**
 * Cosine similarity. Both arguments are expected to be L2-normalized — the
 * engine normalizes every embedding it emits and centroids are re-normalized on
 * update — so this is a plain dot product, which is what keeps assignment cheap.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`embedding length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}

/**
 * Fold one more face into a running mean of `count` faces, re-normalized.
 *
 * A running mean rather than a re-average over stored vectors: the alternative
 * is holding every embedding of every cluster in memory, which is the O(n²) that
 * incremental assignment exists to avoid.
 */
export function updateCentroid(
  centroid: Float32Array,
  count: number,
  addition: Float32Array,
): Float32Array {
  const out = new Float32Array(centroid.length);
  for (let i = 0; i < centroid.length; i++) {
    out[i] = (centroid[i] * count + addition[i]) / (count + 1);
  }
  return normalize(out);
}

/** Mean of several unit vectors, re-normalized. Used when merging clusters. */
export function meanEmbedding(vectors: ReadonlyArray<Float32Array>): Float32Array {
  if (vectors.length === 0) throw new Error("meanEmbedding needs at least one vector");
  const out = new Float32Array(vectors[0].length);
  for (const v of vectors) {
    for (let i = 0; i < out.length; i++) out[i] += v[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= vectors.length;
  return normalize(out);
}
