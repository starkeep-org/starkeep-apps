/**
 * Derived tags, user tags, and how the two combine (plan §7).
 *
 * §7's central distinction, and conflating the two loses user data:
 *
 * - **Derived tags** are the vocabulary scored against the image embedding.
 *   Recomputable from things already on disk, so they are cache, not state.
 * - **User tags** are typed or corrected per photo. Authoritative, and they must
 *   survive a re-scan, a model swap, a vocabulary change, and
 *   `reapOrphanSidecars` — which is exactly why they cannot live in a sidecar,
 *   whose entire contract is that it is disposable. They live in
 *   `image_enriched`, the syncable app table that already holds captions.
 *
 * **Edits are a diff, not a list.** Removing a suggestion has to persist as a
 * *negative*, or the next scoring re-derives it and it comes back. So the stored
 * shape is `{ added, removed }` and the displayed set is
 * `(derived − removed) ∪ added`, with provenance kept so the UI can tell a
 * confirmed tag from a suggestion.
 *
 * **Where this departs from §7, and why.** §7 says derived tags "belong in the
 * sidecar, versioned by model id and invalidated by the existing `isCurrent`
 * staleness check". They are not stored there. The staleness check keys on the
 * *model*, and derived tags depend on the *vocabulary* as well — so a sidecar cache
 * would keep serving tags from an old vocabulary with nothing marking it stale,
 * which is precisely the silent-wrongness the rest of this store is built to avoid.
 * Instead the vocabulary's text embeddings are cached once (keyed by a hash of the
 * vocabulary itself) and scoring one photo is ~70 dot products, which is far below
 * the cost of being wrong about it.
 *
 * No ONNX here. Building the tag embeddings needs the text tower and therefore the
 * query worker; everything else is arithmetic over vectors already on disk.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cosineSimilarity, decodeEmbedding, encodeEmbedding } from "./embeddings";
import { SCENE_EMBEDDING_DIM, SCENE_MODEL_ID } from "./models";
import { tagEmbeddingsPath } from "./paths";
import { readSceneSidecar } from "./sidecars";

/** What the browser needs to render one photo's tags. */
export interface PhotoTag {
  tag: string;
  /**
   * Where this tag came from — the provenance §7 asks to keep.
   *
   * `suggested` is a derived tag nobody has acted on; `confirmed` is a derived tag
   * the user kept explicitly; `added` is one the user typed. Only the last two are
   * publishable (§7), because an uncalibrated score must not become another app's
   * ground truth.
   */
  source: "suggested" | "confirmed" | "added";
  /** Cosine against the image embedding, when this tag came from the vocabulary. */
  score: number | null;
}

/** `{ added, removed }` as stored in `image_enriched.tag_edits`. */
export interface TagEdits {
  added: string[];
  removed: string[];
}

export function emptyTagEdits(): TagEdits {
  return { added: [], removed: [] };
}

/**
 * Parse the stored diff, tolerating anything.
 *
 * A malformed value reads as "no edits" rather than throwing: this column syncs, so
 * a row written by a future version of Photos must not make the current one unable
 * to show a photo.
 */
export function parseTagEdits(raw: unknown): TagEdits {
  if (typeof raw !== "string" || raw.trim() === "") return emptyTagEdits();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyTagEdits();
  }
  const asObject = parsed as { added?: unknown; removed?: unknown } | null;
  return {
    added: stringList(asObject?.added),
    removed: stringList(asObject?.removed),
  };
}

export function serializeTagEdits(edits: TagEdits): string | null {
  // Null rather than `{"added":[],"removed":[]}` for an empty diff, so a photo with
  // no edits leaves no row content behind and "has the user touched this?" stays
  // answerable.
  if (edits.added.length === 0 && edits.removed.length === 0) return null;
  return JSON.stringify(edits);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

// ---------------------------------------------------------------------------
// The vocabulary's text embeddings
// ---------------------------------------------------------------------------

interface TagEmbeddingFile {
  /** Which text tower and vocabulary these came from. */
  modelId: string;
  /** Hash of the vocabulary, so a changed list invalidates without a version bump. */
  vocabularyHash: string;
  /** Parallel arrays: `tags[i]`'s vector is `vectors[i]`. */
  tags: string[];
  /** Base64 little-endian float32, one per tag — the same encoding as sidecars. */
  vectors: string[];
}

export interface TagEmbeddings {
  vocabularyHash: string;
  /** `tag → unit vector`. */
  byTag: Map<string, Float32Array>;
}

/**
 * Identity of a vocabulary, order-independent.
 *
 * Sorted before hashing because reordering the list in Settings does not change
 * what any photo scores, and rebuilding ~70 text embeddings for a reorder would be
 * work with no result.
 */
export function vocabularyHash(vocabulary: readonly string[]): string {
  const normalized = [...new Set(vocabulary.map((t) => t.trim()).filter((t) => t.length > 0))]
    .sort()
    .join("");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * JSON rather than the packed binary `scene-index.bin` uses, deliberately.
 *
 * The scene index is one row per *photo* and has to stay fast to read at any
 * library size; this is one row per *vocabulary entry* — tens to a few hundred, so
 * under a megabyte — and it has to carry the tag strings themselves. A second
 * binary container for that would be more format than the data justifies.
 */
export function writeTagEmbeddings(
  vocabulary: readonly string[],
  vectors: readonly Float32Array[],
): void {
  if (vocabulary.length !== vectors.length) {
    throw new Error(`${vocabulary.length} tags but ${vectors.length} vectors`);
  }
  const file: TagEmbeddingFile = {
    modelId: SCENE_MODEL_ID,
    vocabularyHash: vocabularyHash(vocabulary),
    tags: [...vocabulary],
    vectors: vectors.map(encodeEmbedding),
  };
  const path = tagEmbeddingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file)}\n`, "utf-8");
  renameSync(tmp, path);
}

/**
 * Read the cache, or `null` if it cannot be used.
 *
 * Derived and disposable like the scene index, so every rejection means "rebuild":
 * absent, unparseable, wrong model, or — the one that matters — built for a
 * different vocabulary. Scoring against a stale vocabulary would suggest tags the
 * user has deleted from the list and silently omit ones they added.
 */
export function readTagEmbeddings(expectedVocabulary?: readonly string[]): TagEmbeddings | null {
  let file: TagEmbeddingFile;
  try {
    file = JSON.parse(readFileSync(tagEmbeddingsPath(), "utf-8")) as TagEmbeddingFile;
  } catch {
    return null;
  }
  if (file.modelId !== SCENE_MODEL_ID) return null;
  if (!Array.isArray(file.tags) || !Array.isArray(file.vectors)) return null;
  if (file.tags.length !== file.vectors.length) return null;
  if (expectedVocabulary && file.vocabularyHash !== vocabularyHash(expectedVocabulary)) {
    return null;
  }

  const byTag = new Map<string, Float32Array>();
  for (const [index, tag] of file.tags.entries()) {
    let vector: Float32Array;
    try {
      vector = decodeEmbedding(file.vectors[index]);
    } catch {
      return null;
    }
    if (vector.length !== SCENE_EMBEDDING_DIM) return null;
    byTag.set(tag, vector);
  }
  return { vocabularyHash: file.vocabularyHash, byTag };
}

export function deleteTagEmbeddings(): void {
  rmSync(tagEmbeddingsPath(), { force: true });
}

// ---------------------------------------------------------------------------
// Deriving and combining
// ---------------------------------------------------------------------------

/**
 * Score the vocabulary against one photo's embedding.
 *
 * Returned sorted, highest first, and **not** thresholded here — the caller applies
 * the cutoff, because the tag editor wants to offer near-misses as things to add
 * while the display wants only what cleared the bar.
 */
export function scoreVocabulary(
  imageEmbedding: Float32Array,
  embeddings: TagEmbeddings,
): Array<{ tag: string; score: number }> {
  const out: Array<{ tag: string; score: number }> = [];
  for (const [tag, vector] of embeddings.byTag) {
    out.push({ tag, score: cosineSimilarity(imageEmbedding, vector) });
  }
  out.sort((a, b) => b.score - a.score || (a.tag < b.tag ? -1 : 1));
  return out;
}

/**
 * `(derived − removed) ∪ added`, with provenance (§7).
 *
 * The set arithmetic is the whole contract:
 *
 * - a suggestion the user removed stays gone, however strongly it re-scores;
 * - a tag the user added survives even if the vocabulary never suggested it, which
 *   is what makes user tags authoritative rather than a filter over derived ones;
 * - a suggestion the user has not touched is `suggested`, so the UI can show it
 *   differently and the publisher can decline to publish it.
 *
 * `confirmed` is a derived tag the user explicitly kept — it appears in both
 * `derived` and `added`. Keeping that distinct from `added` matters for publishing:
 * both are publishable, but only one of them means "the model was right".
 */
export function combineTags(
  derived: ReadonlyArray<{ tag: string; score: number }>,
  edits: TagEdits,
  threshold: number,
): PhotoTag[] {
  const removed = new Set(edits.removed);
  const added = new Set(edits.added);
  const out: PhotoTag[] = [];
  const seen = new Set<string>();

  for (const { tag, score } of derived) {
    if (score < threshold) continue;
    if (removed.has(tag)) continue;
    seen.add(tag);
    out.push({ tag, source: added.has(tag) ? "confirmed" : "suggested", score });
  }

  for (const tag of edits.added) {
    if (seen.has(tag)) continue;
    // A user tag the vocabulary did not suggest — either not in the list at all, or
    // in it and below threshold. Either way the user's judgement wins, and there is
    // no meaningful score to report for it.
    out.push({ tag, source: "added", score: null });
  }

  return out;
}

/**
 * Everything the tag UI needs for one photo.
 *
 * Returns `null` when the photo has no scene embedding — not an error, just "this
 * photo has not been described yet".
 */
export function tagsForRecord(
  recordId: string,
  edits: TagEdits,
  vocabulary: readonly string[],
  threshold: number,
): { tags: PhotoTag[]; suggestions: Array<{ tag: string; score: number }> } | null {
  const sidecar = readSceneSidecar(recordId);
  if (!sidecar) return null;

  // An **empty vocabulary means "no suggestions"**, which is a legitimate
  // configuration and not a failure to compute one. Falling through to the cache
  // read here would return null — reporting a photo that *is* described as
  // undescribed — because there is no cache file for a list with nothing in it.
  // The user's own tags still apply, and are the whole answer in this state.
  if (vocabulary.length === 0) {
    return { tags: combineTags([], edits, threshold), suggestions: [] };
  }

  const embeddings = readTagEmbeddings(vocabulary);
  if (!embeddings) return null;

  let imageEmbedding: Float32Array;
  try {
    imageEmbedding = decodeEmbedding(sidecar.embedding);
  } catch {
    return null;
  }

  const derived = scoreVocabulary(imageEmbedding, embeddings);
  return {
    tags: combineTags(derived, edits, threshold),
    // The near-misses, for an editor offering "did you mean". Below threshold and
    // not already removed, so the list is things the user might plausibly add.
    suggestions: derived
      .filter((entry) => entry.score < threshold && !edits.removed.includes(entry.tag))
      .slice(0, 10),
  };
}
