import { describe, expect, it } from "vitest";
import {
  applyAffine,
  ARCFACE_TEMPLATE,
  invertAffine,
  iou,
  nms,
  umeyamaSimilarity,
  type Box,
} from "@/vision/engine/geometry";

describe("iou", () => {
  it("is 1 for identical boxes and 0 for disjoint ones", () => {
    const a: Box = [0, 0, 10, 10];
    expect(iou(a, a)).toBe(1);
    expect(iou(a, [20, 20, 30, 30])).toBe(0);
  });

  it("counts a shared edge as no overlap", () => {
    // Touching boxes have zero area in common. Treating this as an overlap
    // would let NMS suppress two adjacent faces as one.
    expect(iou([0, 0, 10, 10], [10, 0, 20, 10])).toBe(0);
  });

  it("computes partial overlap", () => {
    // 5×10 shared out of a 150 union.
    expect(iou([0, 0, 10, 10], [5, 0, 15, 10])).toBeCloseTo(50 / 150, 10);
  });
});

describe("nms", () => {
  it("keeps the highest-scoring box of an overlapping pair", () => {
    const boxes: Box[] = [
      [0, 0, 10, 10],
      [1, 1, 11, 11],
    ];
    expect(nms(boxes, [0.6, 0.9], 0.4)).toEqual([1]);
  });

  it("keeps both when they are far enough apart", () => {
    const boxes: Box[] = [
      [0, 0, 10, 10],
      [100, 100, 110, 110],
    ];
    expect(nms(boxes, [0.6, 0.9], 0.4)).toEqual([1, 0]);
  });

  it("returns survivors highest-score first", () => {
    const boxes: Box[] = [
      [0, 0, 10, 10],
      [50, 50, 60, 60],
      [100, 100, 110, 110],
    ];
    expect(nms(boxes, [0.3, 0.9, 0.6], 0.4)).toEqual([1, 2, 0]);
  });

  it("does not let a suppressed box suppress others", () => {
    // A and C do not overlap; B overlaps both. Greedy NMS must keep A (top
    // score), drop B, and still keep C — a chained suppression through B would
    // silently lose a real face.
    const boxes: Box[] = [
      [0, 0, 10, 10],
      [6, 0, 16, 10],
      [12, 0, 22, 10],
    ];
    expect(nms(boxes, [0.9, 0.8, 0.7], 0.2).sort()).toEqual([0, 2]);
  });
});

describe("umeyamaSimilarity", () => {
  it("recovers a known rotation, scale, and translation exactly", () => {
    const src: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 3],
    ];
    // 30°, scale 2.5, translated by (7, −4).
    const theta = Math.PI / 6;
    const scale = 2.5;
    const dst = src.map(
      ([x, y]) =>
        [
          scale * (Math.cos(theta) * x - Math.sin(theta) * y) + 7,
          scale * (Math.sin(theta) * x + Math.cos(theta) * y) - 4,
        ] as [number, number],
    );

    const m = umeyamaSimilarity(src, dst);
    expect(m.a).toBeCloseTo(scale * Math.cos(theta), 6);
    expect(m.b).toBeCloseTo(-scale * Math.sin(theta), 6);
    expect(m.c).toBeCloseTo(scale * Math.sin(theta), 6);
    expect(m.d).toBeCloseTo(scale * Math.cos(theta), 6);
    expect(m.tx).toBeCloseTo(7, 6);
    expect(m.ty).toBeCloseTo(-4, 6);
  });

  it("stays a similarity — no shear, uniform scale — under noisy points", () => {
    // Five landmarks over-determine even a similarity fit, and the whole point
    // of fitting a similarity rather than a full affine is that a bad keypoint
    // cannot shear the crop.
    const src: Array<[number, number]> = [
      [10, 10],
      [30, 12],
      [20, 25],
      [12, 38],
      [29, 40],
    ];
    const dst = ARCFACE_TEMPLATE.map(([x, y]) => [x, y] as [number, number]);
    dst[2] = [dst[2][0] + 6, dst[2][1] - 5]; // a badly-placed nose

    const m = umeyamaSimilarity(src, dst);
    expect(m.a).toBeCloseTo(m.d, 10);
    expect(m.b).toBeCloseTo(-m.c, 10);
  });

  it("maps the identity case to the identity transform", () => {
    const m = umeyamaSimilarity(ARCFACE_TEMPLATE, ARCFACE_TEMPLATE);
    expect(m.a).toBeCloseTo(1, 6);
    expect(m.b).toBeCloseTo(0, 6);
    expect(m.tx).toBeCloseTo(0, 4);
    expect(m.ty).toBeCloseTo(0, 4);
  });

  it("rejects mismatched or too-short point sets", () => {
    expect(() => umeyamaSimilarity([[0, 0]], [[0, 0]])).toThrow(/≥2 matched points/);
    expect(() =>
      umeyamaSimilarity(
        [
          [0, 0],
          [1, 1],
        ],
        [[0, 0]],
      ),
    ).toThrow();
  });
});

describe("invertAffine", () => {
  it("round-trips a point through the transform and back", () => {
    const m = umeyamaSimilarity(
      [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
      [
        [5, 5],
        [5, 8],
        [2, 5],
      ],
    );
    const inverse = invertAffine(m);
    const [x, y] = applyAffine(m, 3, 7);
    const [bx, by] = applyAffine(inverse, x, y);
    expect(bx).toBeCloseTo(3, 6);
    expect(by).toBeCloseTo(7, 6);
  });

  it("throws on a singular transform rather than producing NaNs", () => {
    // Collinear landmarks collapse the fit. Silent NaNs would propagate into a
    // crop of garbage and then into a plausible-looking embedding.
    expect(() => invertAffine({ a: 0, b: 0, c: 0, d: 0, tx: 0, ty: 0 })).toThrow(/singular/);
  });
});
