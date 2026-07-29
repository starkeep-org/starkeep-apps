import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { FaceEngine, l2Normalize, type EngineResult } from "@/vision/engine/face-engine";
import { cosineSimilarity } from "@/vision/embeddings";
import { faceModelStatus } from "@/vision/models";
import { modelPath } from "@/vision/paths";
import { FACE_DETECTOR_MODEL, FACE_EMBEDDER_MODEL } from "@/vision/models";
import {
  fixturePath,
  fixturesInstalled,
} from "../scripts/lib/vision-fixtures";
import { defaultVisionConfig } from "@/vision/types";

/**
 * The engine, end to end, on real photographs.
 *
 * The plan asked for exactly this (§8 step 3), and it is the only thing that can
 * catch the failure the unit tests cannot: an alignment that is *subtly* wrong.
 * A transposed template, an off-by-half-pixel sampling convention, or a warp
 * that shears — none of them throw, none of them change a box, and every unit
 * test in this package still passes. They show up only as embeddings that no
 * longer separate, which is what the similarity floor and ceiling below measure.
 *
 * **Skipped unless the models and fixtures are installed:**
 *
 *     pnpm vision:fetch-models      # ~278 MB, non-commercial research licence
 *     pnpm vision:fetch-fixtures    # 4 public-domain photographs
 *
 * Neither is committed, so this does not run in a bare checkout. The tradeoff is
 * deliberate: a repository should not carry a quarter of a gigabyte of
 * non-commercially-licensed weights, nor photographs of people's faces, in order
 * to run its test suite.
 */

const ready = faceModelStatus().installed && fixturesInstalled();

const analyzeCache = new Map<string, EngineResult>();
let engine: FaceEngine;

beforeAll(async () => {
  if (!ready) return;
  engine = await FaceEngine.create({
    detectorPath: modelPath(FACE_DETECTOR_MODEL.fileName),
    embedderPath: modelPath(FACE_EMBEDDER_MODEL.fileName),
  });
}, 180_000);

afterAll(async () => {
  await engine?.dispose();
});

/** Each fixture is analysed once; ~0.3–0.6 s a photo is worth caching. */
async function analyze(fileName: string): Promise<EngineResult> {
  const cached = analyzeCache.get(fileName);
  if (cached) return cached;
  const result = await engine.analyze(new Uint8Array(readFileSync(fixturePath(fileName))));
  analyzeCache.set(fileName, result);
  return result;
}

/** Faces left-to-right, so two photos of the same group can be compared by position. */
function byX(result: EngineResult) {
  return [...result.faces].sort((a, b) => a.bbox[0] - b.bbox[0]);
}

describe.skipIf(!ready)("FaceEngine.analyze", () => {
  it("finds exactly one face in a portrait", async () => {
    const result = await analyze("portrait-a1.jpg");
    expect(result.faces).toHaveLength(1);
    expect(result.faces[0].score).toBeGreaterThan(0.5);
  }, 60_000);

  it("finds exactly four in a four-person group photo", async () => {
    // Cross-stride NMS is what makes this four rather than six or seven: the
    // same face is routinely picked up by two heads.
    const result = await analyze("group-4.jpg");
    expect(result.faces).toHaveLength(4);
  }, 60_000);

  it("returns boxes and landmarks inside the image", async () => {
    const result = await analyze("group-4.jpg");
    for (const face of result.faces) {
      const [x, y, w, h] = face.bbox;
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
      expect(x).toBeGreaterThanOrEqual(-w);
      expect(y).toBeGreaterThanOrEqual(-h);
      expect(x + w).toBeLessThanOrEqual(result.width + w);
      expect(y + h).toBeLessThanOrEqual(result.height + h);
      // Five landmarks, and each inside its own box's neighbourhood.
      expect(face.kps).toHaveLength(5);
      for (const [kx, ky] of face.kps) {
        expect(kx).toBeGreaterThan(x - w);
        expect(kx).toBeLessThan(x + 2 * w);
        expect(ky).toBeGreaterThan(y - h);
        expect(ky).toBeLessThan(y + 2 * h);
      }
    }
  }, 60_000);

  it("emits unit-length 512-d embeddings", async () => {
    // Cosine similarity is a plain dot product downstream, and every threshold
    // in the feature assumes that.
    const result = await analyze("portrait-a1.jpg");
    const embedding = result.faces[0].embedding;
    expect(embedding).toHaveLength(512);
    expect(cosineSimilarity(embedding, embedding)).toBeCloseTo(1, 5);
  }, 60_000);
});

describe.skipIf(!ready)("identity separation", () => {
  it("matches the same person across two different portraits", async () => {
    // The floor. A broken alignment lands this around 0.3–0.5 without throwing
    // anything, and every other test in the package still passes.
    const [a1, a2] = await Promise.all([analyze("portrait-a1.jpg"), analyze("portrait-a2.jpg")]);
    const score = cosineSimilarity(a1.faces[0].embedding, a2.faces[0].embedding);
    expect(score).toBeGreaterThan(0.6);
  }, 60_000);

  it("separates different people", async () => {
    // The ceiling. The other three faces in the group photo are not person A.
    const [portrait, group] = await Promise.all([analyze("portrait-a1.jpg"), analyze("group-4.jpg")]);
    const scores = group.faces.map((f) => cosineSimilarity(portrait.faces[0].embedding, f.embedding));
    const matches = scores.filter((s) => s > 0.5);
    expect(matches).toHaveLength(1);
    for (const other of scores.filter((s) => s <= 0.5)) {
      expect(other).toBeLessThan(0.4);
    }
  }, 60_000);

  it("leaves the default threshold in the gap between them", async () => {
    // 0.45 is only a good default if nothing lands near it. This asserts the
    // margin rather than the constant: a model swap that narrowed the gap would
    // make the default wrong, and that is the thing worth being told about.
    const [a1, a2, group] = await Promise.all([
      analyze("portrait-a1.jpg"),
      analyze("portrait-a2.jpg"),
      analyze("group-4.jpg"),
    ]);
    const threshold = defaultVisionConfig().faces.threshold;
    const samePerson = cosineSimilarity(a1.faces[0].embedding, a2.faces[0].embedding);
    const differentPeople = group.faces
      .map((f) => cosineSimilarity(a1.faces[0].embedding, f.embedding))
      .filter((s) => s < 0.5);

    expect(samePerson).toBeGreaterThan(threshold + 0.1);
    for (const score of differentPeople) expect(score).toBeLessThan(threshold - 0.1);
  }, 60_000);

  it("matches each person across two photos of the same group", async () => {
    // Four identities at once: the cross-photo similarity matrix must be a
    // permutation. A transposed or sheared warp still produces four faces and
    // four embeddings — it just stops producing a diagonal.
    const [first, second] = await Promise.all([analyze("group-4.jpg"), analyze("group-4b.jpg")]);
    expect(first.faces).toHaveLength(4);
    expect(second.faces).toHaveLength(4);

    const left = byX(first);
    const right = byX(second);
    const bestMatch = left.map((f) => {
      const scores = right.map((g) => cosineSimilarity(f.embedding, g.embedding));
      return scores.indexOf(Math.max(...scores));
    });
    // Every face in the first photo picks a different face in the second.
    expect(new Set(bestMatch).size).toBe(4);
  }, 120_000);
});

describe.skipIf(!ready)("EXIF orientation", () => {
  /**
   * The same pixels, tagged orientation 6 ("rotate 90° CW for display").
   * `.rotate()` in the engine must apply it, so every coordinate comes back in
   * the space `photo-viewer.tsx` renders in.
   */
  async function rotatedCopy(fileName: string): Promise<Uint8Array> {
    const source = readFileSync(fixturePath(fileName));
    const tagged = await sharp(source).keepMetadata().withMetadata({ orientation: 6 }).jpeg().toBuffer();
    return new Uint8Array(tagged);
  }

  it("reports display dimensions, not stored ones", async () => {
    const plain = await analyze("portrait-a1.jpg");
    const rotated = await engine.analyze(await rotatedCopy("portrait-a1.jpg"));
    expect(rotated.width).toBe(plain.height);
    expect(rotated.height).toBe(plain.width);
  }, 120_000);

  it("puts the box in display space", async () => {
    // Without `.rotate()` the box would come back at the *unrotated*
    // coordinates — correct-but-transposed, and only on photos that carry an
    // orientation tag. The overlay would then be wrong on a subset of the
    // library, which is exactly the bug that survives a demo.
    const plain = await analyze("portrait-a1.jpg");
    const rotated = await engine.analyze(await rotatedCopy("portrait-a1.jpg"));

    const [x, y, w, h] = plain.faces[0].bbox;
    // 90° CW: (x, y) → (H − y − h, x), and the box's axes swap.
    const expectedX = plain.height - y - h;
    const expectedY = x;
    const tolerance = plain.height * 0.03;

    const [rx, ry, rw, rh] = rotated.faces[0].bbox;
    expect(Math.abs(rx - expectedX)).toBeLessThan(tolerance);
    expect(Math.abs(ry - expectedY)).toBeLessThan(tolerance);
    // Axes swapped: the rotated box is as wide as the original was tall.
    expect(Math.abs(rw - h)).toBeLessThan(tolerance);
    expect(Math.abs(rh - w)).toBeLessThan(tolerance);
  }, 120_000);

  it("still recognises it as the same person", async () => {
    const plain = await analyze("portrait-a1.jpg");
    const rotated = await engine.analyze(await rotatedCopy("portrait-a1.jpg"));
    expect(cosineSimilarity(plain.faces[0].embedding, rotated.faces[0].embedding)).toBeGreaterThan(
      0.7,
    );
  }, 120_000);
});

describe.skipIf(!ready)("robustness", () => {
  it("returns no faces for an image with none, rather than throwing", async () => {
    // The scan writes a sidecar either way; a throw here would count the photo
    // as failed and retry it on every pass forever.
    const blank = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 90, b: 160 } },
    })
      .jpeg()
      .toBuffer();
    const result = await engine.analyze(new Uint8Array(blank));
    expect(result.faces).toEqual([]);
    expect(result.width).toBe(800);
  }, 60_000);

  it("handles a greyscale image", async () => {
    // `removeAlpha().toColorspace("srgb")` has to produce three channels
    // whatever the source was; a single-channel buffer would misalign every
    // pixel read in the warp.
    const grey = await sharp(readFileSync(fixturePath("portrait-a1.jpg"))).greyscale().jpeg().toBuffer();
    const result = await engine.analyze(new Uint8Array(grey));
    expect(result.faces.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("handles a PNG with an alpha channel", async () => {
    const withAlpha = await sharp(readFileSync(fixturePath("portrait-a1.jpg")))
      .ensureAlpha()
      .png()
      .toBuffer();
    const result = await engine.analyze(new Uint8Array(withAlpha));
    expect(result.faces).toHaveLength(1);
  }, 60_000);

  it("rejects bytes that are not an image", async () => {
    await expect(engine.analyze(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  }, 60_000);
});

describe("l2Normalize", () => {
  // Pure, so unlike everything above it runs without the models.
  it("scales a vector to unit length", () => {
    const out = l2Normalize(new Float32Array([3, 4, 0, 0]));
    expect(out[0]).toBeCloseTo(0.6, 6);
    expect(out[1]).toBeCloseTo(0.8, 6);
  });

  it("leaves a zero vector alone rather than producing NaNs", () => {
    const out = l2Normalize(new Float32Array([0, 0, 0]));
    expect([...out]).toEqual([0, 0, 0]);
  });
});
