import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SceneEngine } from "@/vision/engine/siglip";
import { TextEngine } from "@/vision/engine/siglip-text";
import { cosineSimilarity } from "@/vision/embeddings";
import {
  modelStatus,
  SCENE_EMBEDDING_DIM,
  SCENE_IMAGE_MODEL,
  searchModelStatus,
  SEARCH_TEXT_MODEL,
  SEARCH_TOKENIZER,
} from "@/vision/models";
import { modelPath } from "@/vision/paths";
import { promptVariants } from "@/vision/search/search";
import { fixturePath, fixturesInstalled } from "../scripts/lib/vision-fixtures";

/**
 * The text tower, and the property the entire search feature rests on:
 *
 *     **the text tower and the image tower embed into the same space.**
 *
 * Nothing else establishes it. The tokenizer is verified against HuggingFace, the
 * image tower's pairwise structure is verified on photographs, and the index
 * round-trips — and all of that can pass while the two towers produce vectors that
 * have nothing to do with each other. A wrong output tensor, a projection
 * mismatch, a normalization divergence: any of them leaves search returning
 * confidently ordered noise, with no error anywhere.
 *
 * So this ranks real photographs against real English and asserts the ordering.
 * `pnpm vision:spot-check` is the same check as a readable matrix, for when the
 * question is "how good is it" rather than "is it wired up".
 *
 * **Skipped unless both towers and the fixtures are installed:**
 *
 *     pnpm vision:fetch-models --scene --search
 *     pnpm vision:fetch-fixtures
 */

const ready =
  modelStatus("scene").installed && searchModelStatus().installed && fixturesInstalled();

/** See the note in `vision-scene-engine.integration.test.ts` — GB-scale graphs contend. */
const MODEL_TIMEOUT_MS = 120_000;

let imageEngine: SceneEngine;
let textEngine: TextEngine;
const imageVectors = new Map<string, Float32Array>();

beforeAll(async () => {
  if (!ready) return;
  imageEngine = await SceneEngine.create({ imagePath: modelPath(SCENE_IMAGE_MODEL.fileName) });
  textEngine = await TextEngine.create({
    textPath: modelPath(SEARCH_TEXT_MODEL.fileName),
    tokenizerPath: modelPath(SEARCH_TOKENIZER.fileName),
  });
  for (const name of ["portrait-a1.jpg", "portrait-a2.jpg", "group-4.jpg", "group-4b.jpg"]) {
    const result = await imageEngine.embed(new Uint8Array(readFileSync(fixturePath(name))));
    imageVectors.set(name, result.embedding);
  }
}, 300_000);

afterAll(async () => {
  await Promise.all([imageEngine?.dispose(), textEngine?.dispose()]);
});

/** Best cosine over a set of fixtures, which is how a ranked search sees them. */
function best(names: readonly string[], query: Float32Array): number {
  return Math.max(...names.map((n) => cosineSimilarity(imageVectors.get(n)!, query)));
}

const PORTRAITS = ["portrait-a1.jpg", "portrait-a2.jpg"];
const GROUPS = ["group-4.jpg", "group-4b.jpg"];

describe.skipIf(!ready)("TextEngine.embed", { timeout: MODEL_TIMEOUT_MS }, () => {
  it("returns one unit-length vector of the projection width", async () => {
    const vector = await textEngine.embed("at the beach");
    expect(vector.length).toBe(SCENE_EMBEDDING_DIM);
    let sum = 0;
    for (const v of vector) sum += v * v;
    expect(Math.sqrt(sum)).toBeCloseTo(1, 4);
  });

  it("returns one vector per query when batched", async () => {
    // Batching is what makes prompt ensembling one extra encode rather than one
    // extra round trip, and what will make tag scoring affordable in step 4.
    const vectors = await textEngine.embedAll(["a dog", "a cat", "a beach"]);
    expect(vectors).toHaveLength(3);
    expect(vectors.every((v) => v.length === SCENE_EMBEDDING_DIM)).toBe(true);
    // Distinct queries must not collapse to the same vector.
    expect(cosineSimilarity(vectors[0], vectors[2])).toBeLessThan(0.99);
  });

  it("agrees between the batched and single paths", async () => {
    const [batched] = await textEngine.embedAll(["a photograph of four people together"]);
    const single = await textEngine.embed("a photograph of four people together");
    expect(cosineSimilarity(batched, single)).toBeCloseTo(1, 5);
  });

  it("returns nothing for no queries", async () => {
    expect(await textEngine.embedAll([])).toEqual([]);
  });

  it("is deterministic", async () => {
    const a = await textEngine.embed("a group of several people");
    const b = await textEngine.embed("a group of several people");
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it("distinguishes queries that differ only in case", async () => {
    // Follows from the tokenizer not folding case. Not asserting which is *better* —
    // only that the difference propagates, since a tokenizer bug that lowercased
    // everything would make these identical.
    const mixed = await textEngine.embed("Alice");
    const upper = await textEngine.embed("ALICE");
    expect(cosineSimilarity(mixed, upper)).toBeLessThan(0.999);
  });
});

describe.skipIf(!ready)("cross-modal retrieval", { timeout: MODEL_TIMEOUT_MS }, () => {
  it("prefers portraits for a portrait query and groups for a group query", async () => {
    // The load-bearing assertion. Both directions, because a single direction could
    // pass on an artefact of one fixture being generally "closer to text".
    const portraitQuery = await textEngine.embed("a portrait of a single person");
    expect(best(PORTRAITS, portraitQuery)).toBeGreaterThan(best(GROUPS, portraitQuery));

    const groupQuery = await textEngine.embed("a group of several people");
    expect(best(GROUPS, groupQuery)).toBeGreaterThan(best(PORTRAITS, groupQuery));
  });

  it("counts, on fixtures that happen to make it possible", async () => {
    // The fixtures really are four-person photographs. Not a claim that SigLIP
    // counts reliably — §5.4 says it does not, and routes counting to the detector —
    // but a strong signal that the cross-modal link carries real content.
    const query = await textEngine.embed("a photograph of four people together");
    expect(best(GROUPS, query)).toBeGreaterThan(best(PORTRAITS, query));
  });

  it("scores an absent concept near zero", async () => {
    // None of the fixtures is a beach or a meal. The point is not a threshold —
    // §5.3 refuses those — but that irrelevant queries land far below relevant ones,
    // which is what makes rank order meaningful.
    const absent = await textEngine.embed("a beach at sunset");
    const present = await textEngine.embed("a portrait of a single person");
    const all = [...PORTRAITS, ...GROUPS];
    expect(best(all, absent)).toBeLessThan(best(all, present));
    expect(best(all, absent)).toBeLessThan(0.05);
  });

  it("does not score every image identically for any query", async () => {
    // A dead cross-modal link's signature: plausible numbers, no discrimination.
    for (const text of ["a portrait of a single person", "a group of several people", "a dog"]) {
      const query = await textEngine.embed(text);
      const scores = [...PORTRAITS, ...GROUPS].map((n) =>
        cosineSimilarity(imageVectors.get(n)!, query),
      );
      expect(Math.max(...scores) - Math.min(...scores)).toBeGreaterThan(1e-3);
    }
  });

  it("keeps prompt ensembling close to the raw residual", async () => {
    // §5.3 averages the bare residual with `"a photo of {residual}"` because a
    // fragment is not what a retrieval model saw in training, but a blind template
    // makes ungrammatical text. The average must stay in the same neighbourhood as
    // the raw query, or the ensemble is changing the question rather than hedging.
    const variants = await textEngine.embedAll(promptVariants("at the beach"));
    expect(variants).toHaveLength(2);
    expect(cosineSimilarity(variants[0], variants[1])).toBeGreaterThan(0.5);
  });
});
