/**
 * The single decode every rung and every hash reads.
 *
 * "One decode, every rung" was written at the top of `derive-ladder.ts` long
 * before it was true — each rung called `sharp(source)` again, and so did the
 * ThumbHash, the perceptual hash and two separate dimension reads, for nine
 * full decodes of the same buffer per photo. These assert the properties that
 * make the claim checkable rather than aspirational.
 */
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  decodeForDerivation,
  deriveStillLadder,
  computePerceptualHash,
  computeThumbHash,
} from "../src/photos-lib/image-processing/derive-ladder";
import { STILL_LADDER } from "../src/photos-lib/ladder";

const TOP = STILL_LADDER[STILL_LADDER.length - 1]!.maxLongEdge;

async function noisyJpeg(width: number, height: number): Promise<Uint8Array> {
  // Random pixels rather than a flat fill: a solid colour hashes identically
  // however it was scaled, so it would pass the determinism assertions below
  // without proving anything.
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 12345;
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pixels[i] = seed % 256;
  }
  const buf = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 80 })
    .toBuffer();
  return new Uint8Array(buf);
}

describe("the working image", () => {
  it("is capped at the top of the ladder, because nothing above it is ever emitted", async () => {
    const decoded = await decodeForDerivation(await noisyJpeg(TOP + 600, TOP + 600));
    expect(Math.max(decoded.width, decoded.height)).toBe(TOP);
  }, 60_000);

  it("keeps the original's dimensions, which are what the ladder is computed against", async () => {
    const decoded = await decodeForDerivation(await noisyJpeg(TOP + 600, 300));
    expect(decoded.source.width).toBe(TOP + 600);
    expect(decoded.source.height).toBe(300);
    expect(decoded.source.longEdge).toBe(TOP + 600);
  }, 60_000);

  it("is not shrunk below a source that already fits", async () => {
    const decoded = await decodeForDerivation(await noisyJpeg(640, 480));
    expect(decoded.width).toBe(640);
    expect(decoded.height).toBe(480);
  }, 60_000);
});

describe("hashes do not depend on which rungs a node happened to want", () => {
  // The cloud derives the cheap rungs only and a laptop derives all of them.
  // If the working image tracked the request rather than the ladder, the two
  // would compute different perceptual hashes for the same photo and cross-node
  // duplicate detection would quietly stop agreeing with itself.
  it("agrees between a decode passed in and one done from bytes", async () => {
    const bytes = await noisyJpeg(TOP + 600, 900);
    const decoded = await decodeForDerivation(bytes);
    expect(await computePerceptualHash(decoded)).toBe(await computePerceptualHash(bytes));
    expect(await computeThumbHash(decoded)).toBe(await computeThumbHash(bytes));
  }, 60_000);
});

describe("narrowing the rungs", () => {
  it("emits exactly what was asked for", async () => {
    const bytes = await noisyJpeg(2000, 1500);
    const rungs = await deriveStillLadder(bytes, {
      only: ["image-thumb"],
      codec: "jpeg",
    });
    expect(rungs.map((r) => r.sizeClass)).toEqual(["image-thumb"]);
  }, 60_000);

  it("produces the same bytes for a rung whether or not its neighbours were asked for", async () => {
    const bytes = await noisyJpeg(2000, 1500);
    const [alone] = await deriveStillLadder(bytes, { only: ["image-thumb"], codec: "jpeg" });
    const all = await deriveStillLadder(bytes, { codec: "jpeg" });
    const withOthers = all.find((r) => r.sizeClass === "image-thumb")!;
    expect(Buffer.from(alone!.data).equals(Buffer.from(withOthers.data))).toBe(true);
  }, 60_000);
});

describe("rung dimensions", () => {
  it("never upscale past the source", async () => {
    const bytes = await noisyJpeg(300, 200);
    const rungs = await deriveStillLadder(bytes, { codec: "jpeg" });
    for (const rung of rungs) {
      expect(Math.max(rung.width, rung.height)).toBeLessThanOrEqual(300);
    }
  }, 60_000);

  it("match the bytes they were reported for", async () => {
    const bytes = await noisyJpeg(2000, 1500);
    for (const rung of await deriveStillLadder(bytes, { codec: "jpeg" })) {
      const meta = await sharp(Buffer.from(rung.data)).metadata();
      expect([meta.width, meta.height]).toEqual([rung.width, rung.height]);
    }
  }, 60_000);
});
