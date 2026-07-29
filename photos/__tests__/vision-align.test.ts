import { describe, expect, it } from "vitest";
import { alignmentTransform, toNchwFloat, warpToArcFaceCrop, type RgbImage } from "@/vision/engine/align";
import { applyAffine, ARCFACE_TEMPLATE } from "@/vision/engine/geometry";

/** A `width × height` image whose pixel value is a function of its coordinates. */
function synthetic(width: number, height: number, f: (x: number, y: number) => [number, number, number]): RgbImage {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = f(x, y);
      const i = (y * width + x) * 3;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  return { data, width, height };
}

function pixel(image: RgbImage, x: number, y: number): [number, number, number] {
  const i = (y * image.width + x) * 3;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

describe("alignmentTransform", () => {
  it("maps the landmarks it was given onto the ArcFace template", () => {
    // A face at twice the template's scale, offset — the ordinary case.
    const kps = ARCFACE_TEMPLATE.map(([x, y]) => [x * 2 + 40, y * 2 + 90] as [number, number]);
    const m = alignmentTransform(kps);
    kps.forEach((point, i) => {
      const [x, y] = applyAffine(m, point[0], point[1]);
      expect(x).toBeCloseTo(ARCFACE_TEMPLATE[i][0], 4);
      expect(y).toBeCloseTo(ARCFACE_TEMPLATE[i][1], 4);
    });
  });

  it("insists on exactly five landmarks", () => {
    expect(() => alignmentTransform([[0, 0]])).toThrow(/5 landmarks/);
  });
});

describe("warpToArcFaceCrop", () => {
  it("reproduces the source when the transform is the identity", () => {
    const source = synthetic(112, 112, (x, y) => [x % 256, y % 256, 128]);
    const crop = warpToArcFaceCrop(source, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, 112);
    expect(crop.width).toBe(112);
    expect(pixel(crop, 10, 20)).toEqual([10, 20, 128]);
    expect(pixel(crop, 100, 5)).toEqual([100, 5, 128]);
  });

  it("halves a 224² source into a 112² crop under a 0.5 scale", () => {
    // A horizontal ramp: destination x should read source 2x.
    const source = synthetic(224, 224, (x) => [x, 0, 0]);
    const crop = warpToArcFaceCrop(source, { a: 0.5, b: 0, c: 0, d: 0.5, tx: 0, ty: 0 }, 112);
    // Destination x samples source 2x+0.5 under the pixel-centre convention,
    // landing halfway between two ramp steps and rounding up.
    expect(pixel(crop, 0, 0)[0]).toBe(1);
    expect(pixel(crop, 50, 0)[0]).toBe(101);
    expect(pixel(crop, 100, 0)[0]).toBe(201);
  });

  it("interpolates rather than snapping to the nearest pixel", () => {
    // Sampling half a pixel off a two-tone edge must land between the tones;
    // nearest-neighbour would return one of them exactly.
    const source = synthetic(4, 1, (x) => [x < 2 ? 0 : 200, 0, 0]);
    const crop = warpToArcFaceCrop(source, { a: 1, b: 0, c: 0, d: 1, tx: -1.5, ty: 0 }, 1);
    expect(pixel(crop, 0, 0)[0]).toBe(100);
  });

  it("clamps to the edge instead of sampling black outside the frame", () => {
    // A face at the frame border smears the margin. Black there would read to
    // the model as an occlusion that is not in the photo.
    const source = synthetic(4, 4, () => [200, 100, 50]);
    const crop = warpToArcFaceCrop(source, { a: 1, b: 0, c: 0, d: 1, tx: 10, ty: 10 }, 4);
    expect(pixel(crop, 0, 0)).toEqual([200, 100, 50]);
  });

  it("rejects a singular transform rather than emitting NaN pixels", () => {
    const source = synthetic(8, 8, () => [1, 1, 1]);
    expect(() => warpToArcFaceCrop(source, { a: 0, b: 0, c: 0, d: 0, tx: 0, ty: 0 }, 4)).toThrow(
      /singular/,
    );
  });
});

describe("toNchwFloat", () => {
  it("de-interleaves RGB into planes and normalizes", () => {
    const image = synthetic(2, 1, (x) => [x === 0 ? 0 : 255, 128, 255]);
    const out = toNchwFloat(image, 128, 128);
    expect(out.length).toBe(6);
    // R plane, then G plane, then B plane — each 2 pixels wide.
    expect([...out.slice(0, 2)]).toEqual([-1, 127 / 128]);
    expect([...out.slice(2, 4)]).toEqual([0, 0]);
    expect([...out.slice(4, 6)]).toEqual([127 / 128, 127 / 128]);
  });

  it("uses the mean and std it is given, not a hardcoded pair", () => {
    // SCRFD normalizes with std 128 and ArcFace with 127.5; a single hardcoded
    // constant would be subtly wrong for one of them.
    const image = synthetic(1, 1, () => [255, 255, 255]);
    expect(toNchwFloat(image, 127.5, 128)[0]).toBeCloseTo(127.5 / 128, 10);
    expect(toNchwFloat(image, 127.5, 127.5)[0]).toBeCloseTo(1, 10);
  });
});
