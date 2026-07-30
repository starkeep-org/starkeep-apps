import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeEmbedding, normalize } from "@/vision/embeddings";
import { SCENE_EMBEDDING_DIM, SCENE_MODEL_ID } from "@/vision/models";
import { writeTaskSidecar } from "@/vision/sidecars";
import {
  combineTags,
  deleteTagEmbeddings,
  emptyTagEdits,
  parseTagEdits,
  readTagEmbeddings,
  scoreVocabulary,
  serializeTagEdits,
  tagsForRecord,
  vocabularyHash,
  writeTagEmbeddings,
} from "@/vision/tags";
import { DEFAULT_TAG_VOCABULARY, SCENE_SIDECAR_VERSION } from "@/vision/types";

/**
 * Tags (plan §7).
 *
 * The centre of gravity here is the **diff**, because that is where user data gets
 * lost. §7's requirement is that removing a suggestion persists as a *negative* — a
 * local filter would look identical until the next scoring re-derived the tag and it
 * silently came back — and that a tag the user typed survives a re-scan, a model
 * swap, and a vocabulary change.
 *
 * The other half is the tag-embedding cache, which is **derived and disposable** in
 * exactly the way the scene index is: every way it can be wrong resolves to
 * "rebuild", and the one that matters most is being built for a *different
 * vocabulary*, since scoring against a stale list suggests tags the user deleted
 * and omits ones they added.
 */

let root: string;
let previousDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "starkeep-tags-"));
  previousDir = process.env.STARKEEP_DIR;
  process.env.STARKEEP_DIR = root;
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.STARKEEP_DIR;
  else process.env.STARKEEP_DIR = previousDir;
  rmSync(root, { recursive: true, force: true });
});

function axis(index: number): Float32Array {
  const v = new Float32Array(SCENE_EMBEDDING_DIM);
  v[index] = 1;
  return v;
}

/** A vector `weight` towards axis 0, the rest on axis 1. */
function towards(weight: number): Float32Array {
  const v = new Float32Array(SCENE_EMBEDDING_DIM);
  v[0] = weight;
  v[1] = 1 - weight;
  return normalize(v);
}

function seedScene(recordId: string, vector: Float32Array): void {
  writeTaskSidecar("scene", recordId, {
    v: SCENE_SIDECAR_VERSION,
    model: SCENE_MODEL_ID,
    processedAt: "2026-07-29T00:00:00.000Z",
    w: 100,
    h: 100,
    embedding: encodeEmbedding(vector),
  });
}

describe("the stored diff", () => {
  it("round-trips", () => {
    const edits = { added: ["birthday"], removed: ["the beach"] };
    expect(parseTagEdits(serializeTagEdits(edits))).toEqual(edits);
  });

  it("serializes an empty diff as null, not as an empty object", () => {
    // So "has the user touched this photo?" stays answerable from the column.
    expect(serializeTagEdits(emptyTagEdits())).toBeNull();
  });

  it("reads anything unusable as no edits rather than throwing", () => {
    // This column syncs, so a row written by a future version of Photos must not
    // make the current one unable to render a photo.
    for (const raw of [null, undefined, "", "   ", "not json", "[]", "42", '{"added":"nope"}']) {
      expect(parseTagEdits(raw)).toEqual(emptyTagEdits());
    }
  });

  it("drops blanks, duplicates, and non-strings", () => {
    const parsed = parseTagEdits(
      JSON.stringify({ added: ["a", "a", " a ", "", "  ", 7, null], removed: ["b", "b"] }),
    );
    expect(parsed.added).toEqual(["a"]);
    expect(parsed.removed).toEqual(["b"]);
  });
});

describe("combineTags", () => {
  const derived = [
    { tag: "the beach", score: 0.2 },
    { tag: "a sunset", score: 0.1 },
    { tag: "a forest", score: 0.01 },
  ];

  it("shows derived tags above the threshold as suggestions", () => {
    const tags = combineTags(derived, emptyTagEdits(), 0.05);
    expect(tags.map((t) => t.tag)).toEqual(["the beach", "a sunset"]);
    expect(tags.every((t) => t.source === "suggested")).toBe(true);
    // A forest is below the bar and therefore absent.
    expect(tags.find((t) => t.tag === "a forest")).toBeUndefined();
  });

  it("keeps a removed suggestion gone however strongly it re-scores", () => {
    // The §7 requirement. Without persisting the negative, the next scoring
    // re-derives it and it silently returns.
    const tags = combineTags(derived, { added: [], removed: ["the beach"] }, 0.05);
    expect(tags.map((t) => t.tag)).toEqual(["a sunset"]);
  });

  it("marks a kept suggestion as confirmed rather than suggested", () => {
    // Both are publishable, but only `confirmed` means "the model was right" — and
    // §7 publishes only what a human agreed with.
    const tags = combineTags(derived, { added: ["the beach"], removed: [] }, 0.05);
    expect(tags.find((t) => t.tag === "the beach")?.source).toBe("confirmed");
    expect(tags.find((t) => t.tag === "a sunset")?.source).toBe("suggested");
  });

  it("keeps a user tag the vocabulary never suggested", () => {
    // What makes user tags authoritative rather than a filter over derived ones.
    const tags = combineTags(derived, { added: ["Grandma's house"], removed: [] }, 0.05);
    const added = tags.find((t) => t.tag === "Grandma's house");
    expect(added).toMatchObject({ source: "added", score: null });
  });

  it("keeps a user tag that the vocabulary scored below the threshold", () => {
    const tags = combineTags(derived, { added: ["a forest"], removed: [] }, 0.05);
    expect(tags.find((t) => t.tag === "a forest")).toMatchObject({ source: "added" });
  });

  it("never lists a tag twice", () => {
    const tags = combineTags(derived, { added: ["the beach", "the beach"], removed: [] }, 0.05);
    expect(tags.filter((t) => t.tag === "the beach")).toHaveLength(1);
  });

  it("shows only user tags when nothing was derived", () => {
    const tags = combineTags([], { added: ["birthday"], removed: [] }, 0.05);
    expect(tags).toEqual([{ tag: "birthday", source: "added", score: null }]);
  });

  it("shows nothing for a photo with no tags and no edits", () => {
    expect(combineTags([], emptyTagEdits(), 0.05)).toEqual([]);
  });
});

describe("vocabularyHash", () => {
  it("is order-independent", () => {
    // Reordering the list in Settings changes nothing any photo scores, so it must
    // not trigger a rebuild of every text embedding.
    expect(vocabularyHash(["a", "b", "c"])).toBe(vocabularyHash(["c", "b", "a"]));
  });

  it("ignores blanks and duplicates, like the config merge does", () => {
    expect(vocabularyHash(["a", "b"])).toBe(vocabularyHash(["a", " b ", "a", ""]));
  });

  it("changes when the content changes", () => {
    expect(vocabularyHash(["a", "b"])).not.toBe(vocabularyHash(["a", "b", "c"]));
    expect(vocabularyHash(["a"])).not.toBe(vocabularyHash(["b"]));
  });

  it("handles an empty vocabulary", () => {
    expect(vocabularyHash([])).toBe(vocabularyHash([""]));
  });
});

describe("the tag embedding cache", () => {
  it("round-trips", () => {
    writeTagEmbeddings(["the beach", "a sunset"], [axis(0), axis(1)]);
    const cached = readTagEmbeddings(["the beach", "a sunset"])!;
    expect([...cached.byTag.keys()].sort()).toEqual(["a sunset", "the beach"]);
    expect(cached.byTag.get("the beach")![0]).toBeCloseTo(1, 6);
  });

  it("returns null when there is nothing cached", () => {
    expect(readTagEmbeddings()).toBeNull();
  });

  it("returns null after a delete", () => {
    writeTagEmbeddings(["a"], [axis(0)]);
    deleteTagEmbeddings();
    expect(readTagEmbeddings()).toBeNull();
    expect(() => deleteTagEmbeddings()).not.toThrow();
  });

  it("returns null when built for a different vocabulary", () => {
    // The rejection that matters. Scoring against a stale list would suggest tags
    // the user deleted from the vocabulary and omit ones they added — with nothing
    // marking it wrong, which is why the hash is checked rather than a version.
    writeTagEmbeddings(["the beach"], [axis(0)]);
    expect(readTagEmbeddings(["the beach"])).not.toBeNull();
    expect(readTagEmbeddings(["a forest"])).toBeNull();
    expect(readTagEmbeddings(["the beach", "a forest"])).toBeNull();
  });

  it("accepts any vocabulary when not asked to check one", () => {
    // The status route wants to say "something is cached" without deciding whether
    // it is current.
    writeTagEmbeddings(["the beach"], [axis(0)]);
    expect(readTagEmbeddings()).not.toBeNull();
  });

  it("ignores a reorder, because the hash does", () => {
    writeTagEmbeddings(["a", "b"], [axis(0), axis(1)]);
    expect(readTagEmbeddings(["b", "a"])).not.toBeNull();
  });

  it("refuses a mismatched write rather than storing a skewed cache", () => {
    expect(() => writeTagEmbeddings(["a", "b"], [axis(0)])).toThrow(/2 tags but 1 vectors/);
  });

  it("round-trips an empty vocabulary", () => {
    // A legitimate choice meaning "no suggestions", and distinct from no cache.
    writeTagEmbeddings([], []);
    const cached = readTagEmbeddings([])!;
    expect(cached.byTag.size).toBe(0);
  });
});

describe("scoreVocabulary", () => {
  it("ranks by cosine, highest first", () => {
    writeTagEmbeddings(["aligned", "orthogonal"], [axis(0), axis(1)]);
    const scored = scoreVocabulary(axis(0), readTagEmbeddings()!);
    expect(scored[0].tag).toBe("aligned");
    expect(scored[0].score).toBeCloseTo(1, 5);
    expect(scored[1].score).toBeCloseTo(0, 5);
  });

  it("is stable for equal scores", () => {
    writeTagEmbeddings(["b", "a"], [axis(1), axis(1)]);
    const first = scoreVocabulary(axis(0), readTagEmbeddings()!).map((s) => s.tag);
    expect(first).toEqual(["a", "b"]);
  });
});

describe("tagsForRecord", () => {
  it("combines the photo's embedding with the vocabulary and the diff", () => {
    seedScene("rec", towards(0.95));
    writeTagEmbeddings(["near", "far"], [axis(0), axis(1)]);

    const result = tagsForRecord("rec", { added: ["mine"], removed: [] }, ["near", "far"], 0.5)!;
    expect(result.tags.map((t) => t.tag).sort()).toEqual(["mine", "near"]);
    expect(result.tags.find((t) => t.tag === "near")?.source).toBe("suggested");
  });

  it("offers below-threshold entries as near misses", () => {
    seedScene("rec", towards(0.95));
    writeTagEmbeddings(["near", "far"], [axis(0), axis(1)]);
    const result = tagsForRecord("rec", emptyTagEdits(), ["near", "far"], 0.5)!;
    expect(result.suggestions.map((s) => s.tag)).toEqual(["far"]);
  });

  it("does not offer a removed tag as a near miss", () => {
    // Otherwise the UI keeps proposing exactly the thing the user rejected.
    seedScene("rec", towards(0.95));
    writeTagEmbeddings(["near", "far"], [axis(0), axis(1)]);
    const result = tagsForRecord("rec", { added: [], removed: ["far"] }, ["near", "far"], 0.5)!;
    expect(result.suggestions).toEqual([]);
  });

  it("returns null for a photo with no scene embedding", () => {
    writeTagEmbeddings(["near"], [axis(0)]);
    expect(tagsForRecord("never-scanned", emptyTagEdits(), ["near"], 0.5)).toBeNull();
  });

  it("returns null when the cache is for another vocabulary", () => {
    seedScene("rec", towards(0.95));
    writeTagEmbeddings(["near"], [axis(0)]);
    expect(tagsForRecord("rec", emptyTagEdits(), ["something", "else"], 0.5)).toBeNull();
  });
});

describe("the parked vocabulary", () => {
  it("ships empty, so nothing is suggested until a list is configured", () => {
    // Retired after measurement: of ~70 hand-authored phrases only 21 ever fired on a
    // real library, one fired on *every* photo (carrying no information), and one
    // dominated as a generic attractor. §11's "too large makes every photo score
    // something", observed rather than predicted.
    expect(DEFAULT_TAG_VOCABULARY).toEqual([]);
  });

  it("leaves a described photo described, with the user's own tags intact", () => {
    // The bug an empty vocabulary exposes: falling through to the embedding cache
    // would find no file for a list with nothing in it and report a photo that *is*
    // described as undescribed. "No suggestions" is a configuration, not a failure.
    seedScene("rec", towards(0.9));
    const result = tagsForRecord("rec", { added: ["mine"], removed: [] }, [], 0.06);
    expect(result).not.toBeNull();
    expect(result!.tags).toEqual([{ tag: "mine", source: "added", score: null }]);
    expect(result!.suggestions).toEqual([]);
  });

  it("still returns null for a photo with no scene embedding", () => {
    // The empty-vocabulary shortcut must not paper over the genuinely-unknown case.
    expect(tagsForRecord("never-scanned", emptyTagEdits(), [], 0.06)).toBeNull();
  });

  it("needs no embedding cache at all", () => {
    // Nothing was written by any test above this point in this block, so this asserts
    // the shortcut runs before the cache read rather than after a lucky hit.
    seedScene("rec", towards(0.9));
    expect(readTagEmbeddings([])).toBeNull();
    expect(tagsForRecord("rec", emptyTagEdits(), [], 0.06)).toEqual({
      tags: [],
      suggestions: [],
    });
  });
});

