import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The search pipeline, end to end but without a model.
 *
 * The query worker is mocked, because what is under test here is the *wiring* —
 * that a name resolves to a person filter, that the residual reaches the dense
 * stage, that a missing index degrades to structured-only instead of failing, and
 * that dismissed chips return their words to the residual. The real towers are
 * covered by `vision-text-engine.integration.test.ts`; none of that needs 2 GB of
 * weights to exercise the plumbing.
 *
 * The stub embeds by keyword rather than returning a constant, so the dense
 * ordering is *checkable*: "beach" scores beachy records highly and everything else
 * near zero. A constant vector would make every dense assertion vacuous.
 */

const embedQueries = vi.fn();

vi.mock("@/vision/search/query-controller", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/vision/search/query-controller")>();
  return { ...actual, embedQueries: (queries: readonly string[]) => embedQueries(queries) };
});

import { encodeEmbedding, normalize } from "@/vision/embeddings";
import { OBJECT_MODEL_ID, SCENE_EMBEDDING_DIM, SCENE_MODEL_ID } from "@/vision/models";
import { newPerson, writePeople } from "@/vision/people";
import { buildSceneIndex } from "@/vision/scene-index";
import { writeTaskSidecar } from "@/vision/sidecars";
import { FACE_MODEL_ID } from "@/vision/models";
import { FACE_SIDECAR_VERSION, OBJECT_SIDECAR_VERSION, SCENE_SIDECAR_VERSION } from "@/vision/types";
import { classIndex } from "@/vision/coco-classes";
import { search, promptVariants } from "@/vision/search/search";

let root: string;
let previousDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "starkeep-search-"));
  previousDir = process.env.STARKEEP_DIR;
  process.env.STARKEEP_DIR = root;
  embedQueries.mockReset();
  // Default: the query embeds onto axis 0, which `beachy()` below aligns with.
  embedQueries.mockImplementation((queries: readonly string[]) =>
    Promise.resolve(queries.map(() => axis(0))),
  );
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

/** A vector `weight` of the way from axis 1 towards axis 0 — i.e. this "beachy". */
function beachy(weight: number): Float32Array {
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

/** A face sidecar assigning one face to `personId`. */
function seedFace(recordId: string, personId: string | null): void {
  writeTaskSidecar("faces", recordId, {
    v: FACE_SIDECAR_VERSION,
    model: FACE_MODEL_ID,
    processedAt: "2026-07-29T00:00:00.000Z",
    w: 100,
    h: 100,
    faces: [
      {
        bbox: [0, 0, 10, 10],
        score: 0.99,
        kps: [
          [1, 1],
          [2, 1],
          [1, 2],
          [1, 3],
          [2, 3],
        ],
        embedding: encodeEmbedding(axis(5)),
        personId,
      },
    ],
  });
}

/** An object sidecar carrying `count` detections of each named class. */
function seedObjects(recordId: string, classes: Record<string, number>): void {
  const objects = Object.entries(classes).flatMap(([name, count]) =>
    Array.from({ length: count }, () => ({
      cls: classIndex(name)!,
      score: 0.9,
      bbox: [0, 0, 10, 10] as [number, number, number, number],
    })),
  );
  writeTaskSidecar("objects", recordId, {
    v: OBJECT_SIDECAR_VERSION,
    model: OBJECT_MODEL_ID,
    processedAt: "2026-07-29T00:00:00.000Z",
    w: 100,
    h: 100,
    objects,
  });
}

function namedPerson(name: string): string {
  const person = newPerson(axis(5));
  const named = { ...person, name };
  writePeople([named]);
  return named.id;
}

describe("promptVariants", () => {
  it("pairs the raw residual with the templated form", () => {
    // §5.3: neither alone is right. A bare fragment is not what a retrieval model
    // saw in training, and a blind template yields "a photo of at the beach".
    expect(promptVariants("at the beach")).toEqual(["at the beach", "a photo of at the beach"]);
  });
});

describe("search", () => {
  it("returns nothing for an empty query without touching the worker", async () => {
    const response = await search("   ");
    expect(response.results).toEqual([]);
    expect(embedQueries).not.toHaveBeenCalled();
  });

  it("ranks by description when the query has no name", async () => {
    seedScene("beachy", beachy(0.95));
    seedScene("middling", beachy(0.5));
    seedScene("indoors", beachy(0.05));
    buildSceneIndex();

    const response = await search("at the beach");
    expect(embedQueries).toHaveBeenCalledWith(["at the beach", "a photo of at the beach"]);
    expect(response.residual).toBe("at the beach");
    expect(response.terms).toEqual([]);
    // All three clear the dense membership floor, so all three are returned — the
    // weakest is no longer discarded just for being the pool's minimum.
    expect(response.results.map((r) => r.recordId)).toEqual(["beachy", "middling", "indoors"]);
  });

  it("filters exactly for a pure-name query", async () => {
    const alice = namedPerson("Alice");
    seedFace("with-alice", alice);
    seedFace("with-stranger", null);

    const response = await search("Alice");
    expect(response.terms.map((t) => t.label)).toEqual(["Alice"]);
    expect(response.residual).toBe("");
    // No residual means no dense stage at all.
    expect(embedQueries).not.toHaveBeenCalled();
    expect(response.results.map((r) => r.recordId)).toEqual(["with-alice"]);
    expect(response.results[0].dense).toBeNull();
  });

  it("puts the name-and-description match on top", async () => {
    // The §5.1 invariant, through the whole pipeline rather than in the ranker
    // alone: score(Alice ∧ beach) > score(Alice) , score(beach).
    const alice = namedPerson("Alice");
    seedFace("alice-beach", alice);
    seedScene("alice-beach", beachy(0.95));
    seedFace("alice-indoors", alice);
    seedScene("alice-indoors", beachy(0.05));
    seedScene("beach-only", beachy(0.9));
    buildSceneIndex();

    const response = await search("Alice at the beach");
    expect(response.results[0].recordId).toBe("alice-beach");
    const ids = response.results.map((r) => r.recordId);
    expect(ids.indexOf("alice-indoors")).toBeLessThan(ids.indexOf("beach-only"));
  });

  it("keeps a photo that matches only the description", async () => {
    // Graceful degradation (§5.1): Alice present but undetected still lands via the
    // dense signal, through the same mechanism rather than a backfill step.
    const alice = namedPerson("Alice");
    seedFace("alice-detected", alice);
    seedScene("alice-detected", beachy(0.5));
    seedScene("alice-undetected", beachy(0.99));
    buildSceneIndex();

    const response = await search("Alice at the beach");
    const ids = response.results.map((r) => r.recordId);
    expect(ids).toContain("alice-undetected");
    expect(ids[0]).toBe("alice-detected");
  });

  it("degrades to structured-only when there is no index", async () => {
    // Derived and disposable, so a missing index is a state to explain, not an
    // error. Names must keep working meanwhile.
    const alice = namedPerson("Alice");
    seedFace("with-alice", alice);

    const response = await search("Alice at the beach");
    expect(response.denseUnavailable).toMatch(/scene/i);
    expect(response.results.map((r) => r.recordId)).toEqual(["with-alice"]);
    expect(embedQueries).not.toHaveBeenCalled();
  });

  it("counts a person once even when they appear twice", async () => {
    // `match_t` is binary (§5.1), so a crowd shot must not outscore a portrait.
    const alice = namedPerson("Alice");
    writeTaskSidecar("faces", "twice", {
      v: FACE_SIDECAR_VERSION,
      model: FACE_MODEL_ID,
      processedAt: "2026-07-29T00:00:00.000Z",
      w: 100,
      h: 100,
      faces: [0, 1].map(() => ({
        bbox: [0, 0, 10, 10] as [number, number, number, number],
        score: 0.9,
        kps: [
          [1, 1],
          [2, 1],
          [1, 2],
          [1, 3],
          [2, 3],
        ] as Array<[number, number]>,
        embedding: encodeEmbedding(axis(5)),
        personId: alice,
      })),
    });
    seedFace("once", alice);

    const response = await search("Alice");
    const scores = new Map(response.results.map((r) => [r.recordId, r.structured]));
    expect(scores.get("twice")).toBe(scores.get("once"));
  });

  it("returns the word to the residual when its chip is dismissed", async () => {
    // §5.2: ✕ says the *interpretation* was wrong, not the word. "rose at the
    // beach" becomes a search for the flower.
    const rose = namedPerson("Rose");
    seedFace("with-rose", rose);
    seedScene("with-rose", beachy(0.2));
    seedScene("actual-roses", beachy(0.9));
    buildSceneIndex();

    const kept = await search("Rose at the beach");
    expect(kept.terms).toHaveLength(1);

    const dropped = await search("Rose at the beach", { dropped: new Set([`person:${rose}`]) });
    expect(dropped.terms).toEqual([]);
    expect(dropped.residual).toBe("Rose at the beach");
    expect(embedQueries).toHaveBeenLastCalledWith([
      "Rose at the beach",
      "a photo of Rose at the beach",
    ]);
  });

  it("honours the limit while reporting the true total", async () => {
    // §5.3: top-k with "show more", never an absolute threshold — so the UI needs
    // an honest total to offer more against.
    for (let i = 0; i < 10; i++) seedScene(`rec-${i}`, beachy(0.1 + i * 0.08));
    buildSceneIndex();

    const response = await search("at the beach", { limit: 3 });
    expect(response.results).toHaveLength(3);
    expect(response.total).toBeGreaterThan(3);
  });

  it("groups results into bands", async () => {
    const alice = namedPerson("Alice");
    seedFace("alice-beach", alice);
    seedScene("alice-beach", beachy(0.9));
    seedScene("beach-only", beachy(0.8));
    seedScene("dull", beachy(0.1));
    buildSceneIndex();

    const response = await search("Alice at the beach");
    expect(response.bands.length).toBeGreaterThanOrEqual(2);
    expect(response.bands[0].terms.map((t) => t.label)).toEqual(["Alice"]);
    expect(response.bands[0].results[0].recordId).toBe("alice-beach");
  });

  it("ignores an unnamed cluster", async () => {
    // An unnamed cluster has no string a human could have typed, so its id must not
    // become matchable by accident.
    const unnamed = newPerson(axis(5));
    writePeople([unnamed]);
    seedFace("someone", unnamed.id);
    seedScene("someone", beachy(0.5));
    buildSceneIndex();

    const response = await search("at the beach");
    expect(response.terms).toEqual([]);
  });
});

describe("object classes in search", () => {
  it("filters by class", async () => {
    seedObjects("has-dog", { dog: 1 });
    seedObjects("has-cat", { cat: 1 });

    const response = await search("dog");
    expect(response.terms.map((t) => `${t.kind}:${t.id}`)).toEqual(["object:dog"]);
    expect(response.results.map((r) => r.recordId)).toEqual(["has-dog"]);
    // No residual, so no dense stage — an exact class filter.
    expect(embedQueries).not.toHaveBeenCalled();
  });

  it("counts detections rather than asking the dense stage", async () => {
    // §5.4: counting routes to detector counts and never to CLIP, which is weak at
    // it. "at least" rather than "exactly", because four dogs is a fine answer to
    // "three dogs" and a detector that missed one should not turn a hit into a miss.
    seedObjects("one-dog", { dog: 1 });
    seedObjects("three-dogs", { dog: 3 });
    seedObjects("five-dogs", { dog: 5 });

    const response = await search("three dogs");
    expect(response.terms[0].count).toBe(3);
    expect(response.results.map((r) => r.recordId).sort()).toEqual(["five-dogs", "three-dogs"]);
  });

  it("does not match classes before anything has been detected", async () => {
    // The store is empty, so "dog" must fall through to the dense stage rather than
    // becoming a filter that matches nothing.
    seedScene("something", beachy(0.9));
    seedScene("other", beachy(0.2));
    buildSceneIndex();

    const response = await search("dog");
    expect(response.terms).toEqual([]);
    expect(embedQueries).toHaveBeenCalledWith(["dog", "a photo of dog"]);
  });

  it("combines a person, a class, and a description", async () => {
    // The full §5.1 stack: two structured terms of different kinds plus a residual.
    const alice = namedPerson("Alice");
    seedFace("all-three", alice);
    seedObjects("all-three", { dog: 1 });
    seedScene("all-three", beachy(0.8));
    seedFace("alice-only", alice);
    seedScene("alice-only", beachy(0.1));
    seedObjects("dog-only", { dog: 1 });
    seedScene("dog-only", beachy(0.1));
    buildSceneIndex();

    const response = await search("Alice with a dog at the beach");
    expect(response.results[0].recordId).toBe("all-three");
    // Person outweighs object, so the Alice photo beats the dog photo.
    const ids = response.results.map((r) => r.recordId);
    expect(ids.indexOf("alice-only")).toBeLessThan(ids.indexOf("dog-only"));
  });

  it("scores a photo matching two classes above one matching either", async () => {
    seedObjects("both", { dog: 1, cat: 1 });
    seedObjects("dog", { dog: 1 });
    seedObjects("cat", { cat: 1 });

    const response = await search("dog cat");
    expect(response.results[0].recordId).toBe("both");
  });

  it("ignores a class the detector never found in a photo", async () => {
    seedObjects("empty", {});
    seedObjects("has-dog", { dog: 1 });

    const response = await search("dog");
    expect(response.results.map((r) => r.recordId)).toEqual(["has-dog"]);
  });
});
