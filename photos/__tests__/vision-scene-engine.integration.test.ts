import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { SceneEngine, toNchwNormalized } from "@/vision/engine/siglip";
import { cosineSimilarity } from "@/vision/embeddings";
import {
  modelStatus,
  SCENE_EMBEDDING_DIM,
  SCENE_IMAGE_MODEL,
  SCENE_INPUT_SIZE,
} from "@/vision/models";
import { modelPath } from "@/vision/paths";
import { fixturePath, fixturesInstalled } from "../scripts/lib/vision-fixtures";

/**
 * The scene image tower, end to end, on real photographs.
 *
 * The failure this exists to catch is the one the unit tests cannot: **silently
 * wrong preprocessing**. SigLIP differs from CLIP in two ways that do not throw,
 * do not change a shape, and do not fail a single unit test —
 *
 *   1. it squashes to a square rather than resizing the short side and
 *      centre-cropping, and
 *   2. it normalizes to [−1, 1] with mean/std 0.5 rather than ImageNet statistics.
 *
 * Get either wrong and the tower still emits 1152 plausible unit-length numbers.
 * What degrades is only *retrieval quality*, months later, with nothing to point
 * at. The structure asserted below — same-subject pairs clearly above
 * different-subject pairs — is what actually distinguishes correct preprocessing
 * from confident nonsense.
 *
 * **Skipped unless the model and fixtures are installed:**
 *
 *     pnpm vision:fetch-models --scene   # ~1.7 GB, Apache-2.0
 *     pnpm vision:fetch-fixtures         # 4 public-domain photographs
 *
 * `pnpm vision:bench-scene` is the same check with timings, for when the question
 * is throughput rather than correctness.
 */

const ready = modelStatus("scene").installed && fixturesInstalled();

/**
 * Generous, because these are the only tests that load a 1.7 GB graph. Each
 * inference is ~1.6 s alone (see `pnpm vision:bench-scene`) but several ONNX suites
 * run in parallel and contend for memory bandwidth, which pushed them past the 5 s
 * default. A timeout here should mean "wedged", not "busy".
 */
const MODEL_TIMEOUT_MS = 120_000;

let engine: SceneEngine;
const cache = new Map<string, Float32Array>();

beforeAll(async () => {
  if (!ready) return;
  engine = await SceneEngine.create({ imagePath: modelPath(SCENE_IMAGE_MODEL.fileName) });
}, 120_000);

afterAll(async () => {
  await engine?.dispose();
});

async function embed(fixture: string): Promise<Float32Array> {
  const hit = cache.get(fixture);
  if (hit) return hit;
  const result = await engine.embed(new Uint8Array(readFileSync(fixturePath(fixture))));
  cache.set(fixture, result.embedding);
  return result.embedding;
}

describe.skipIf(!ready)("SceneEngine.embed", { timeout: MODEL_TIMEOUT_MS }, () => {
  it("returns one unit-length vector of the projection width", async () => {
    const embedding = await embed("portrait-a1.jpg");
    expect(embedding.length).toBe(SCENE_EMBEDDING_DIM);
    let sum = 0;
    for (const v of embedding) sum += v * v;
    // Normalized once by the engine so every cosine downstream is a dot product.
    expect(Math.sqrt(sum)).toBeCloseTo(1, 4);
  });

  it("reports display dimensions, not the 384² it analysed", async () => {
    // The sidecar records what was looked at, and the resize is an internal
    // detail — reporting 384×384 would make `w`/`h` useless to anything else.
    const result = await engine.embed(new Uint8Array(readFileSync(fixturePath("group-4.jpg"))));
    expect(result.width).toBe(4096);
    expect(result.height).toBe(2731);
  });

  it("separates different scenes from near-duplicates of the same one", async () => {
    // The real assertion. Two photos of the same four-person group, and two
    // portraits of one person, must each sit clearly above any portrait/group
    // pairing. Measured spread on this fixture set is ~0.965 within versus
    // ~0.82 across; the thresholds below are loose enough to survive a model
    // patch release and tight enough that a preprocessing regression trips them.
    const [a1, a2, g4, g4b] = await Promise.all([
      embed("portrait-a1.jpg"),
      embed("portrait-a2.jpg"),
      embed("group-4.jpg"),
      embed("group-4b.jpg"),
    ]);

    const sameGroup = cosineSimilarity(g4, g4b);
    const samePerson = cosineSimilarity(a1, a2);
    const across = [
      cosineSimilarity(a1, g4),
      cosineSimilarity(a1, g4b),
      cosineSimilarity(a2, g4),
      cosineSimilarity(a2, g4b),
    ];

    expect(sameGroup).toBeGreaterThan(0.9);
    expect(samePerson).toBeGreaterThan(0.9);
    for (const value of across) {
      expect(value).toBeLessThan(0.9);
      expect(sameGroup).toBeGreaterThan(value);
      expect(samePerson).toBeGreaterThan(value);
    }

    // And the spread is not collapsed. Contrastive embeddings live in a narrow
    // cone, so absolute cosines run high (which is exactly why §5.1 normalizes
    // per query) — but *equally* high for every pair is what a resize that
    // discards the image looks like.
    expect(sameGroup - Math.min(...across)).toBeGreaterThan(0.05);
  });

  it("is deterministic for the same bytes", async () => {
    // Two runs of the same graph on the same input must agree, or nothing built
    // on the stored index means anything across a rebuild.
    const bytes = new Uint8Array(readFileSync(fixturePath("portrait-a1.jpg")));
    const first = await engine.embed(bytes);
    const second = await engine.embed(bytes);
    expect(cosineSimilarity(first.embedding, second.embedding)).toBeCloseTo(1, 5);
  });

  it("handles a PNG with an alpha channel", async () => {
    // `removeAlpha` runs before the tensor pack; without it the raw buffer is
    // 4 channels and the reshape silently reads colour data as geometry.
    const png = await sharp(fixturePath("portrait-a1.jpg")).ensureAlpha().png().toBuffer();
    const result = await engine.embed(new Uint8Array(png));
    expect(result.embedding.length).toBe(SCENE_EMBEDDING_DIM);
    // Same photo, so it must land essentially where the JPEG did.
    expect(cosineSimilarity(result.embedding, await embed("portrait-a1.jpg"))).toBeGreaterThan(0.98);
  });
});

describe("toNchwNormalized", () => {
  // No model needed — this is the arithmetic the whole tower sits on.
  it("maps 0 and 255 to the ends of [−1, 1]", () => {
    const size = 2;
    const black = toNchwNormalized(new Uint8Array(size * size * 3).fill(0), size);
    const white = toNchwNormalized(new Uint8Array(size * size * 3).fill(255), size);
    expect(black[0]).toBeCloseTo(-1, 5);
    expect(white[0]).toBeCloseTo(1, 5);
    // Mid-grey sits at zero: mean/std 0.5, not ImageNet statistics.
    const grey = toNchwNormalized(new Uint8Array(size * size * 3).fill(128), size);
    expect(grey[0]).toBeCloseTo(0, 2);
  });

  it("de-interleaves RGB into channel planes", () => {
    // A 2×2 with one pure pixel per channel plus one white. NCHW is channel-major,
    // so a tensor packed as interleaved would feed the model green where it
    // expects red — which does not throw and does not change the output shape.
    const rgb = new Uint8Array([
      255, 0, 0, // red
      0, 255, 0, // green
      0, 0, 255, // blue
      255, 255, 255, // white
    ]);
    const out = toNchwNormalized(rgb, 2);
    expect(out.length).toBe(12);
    expect([...out.slice(0, 4)]).toEqual([1, -1, -1, 1]); // R plane
    expect([...out.slice(4, 8)]).toEqual([-1, 1, -1, 1]); // G plane
    expect([...out.slice(8, 12)]).toEqual([-1, -1, 1, 1]); // B plane
  });

  it("rejects a buffer that is not size² × 3", () => {
    expect(() => toNchwNormalized(new Uint8Array(10), 4)).toThrow(/expected 48 bytes/);
  });

  it("produces a full-size tensor for the real input size", () => {
    const out = toNchwNormalized(new Uint8Array(SCENE_INPUT_SIZE ** 2 * 3), SCENE_INPUT_SIZE);
    expect(out.length).toBe(3 * SCENE_INPUT_SIZE ** 2);
  });
});
