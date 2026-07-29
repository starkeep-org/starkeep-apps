import { describe, expect, it } from "vitest";
import {
  anchorCentres,
  decodeScrfd,
  decodeStride,
  groupScrfdOutputs,
  letterboxScale,
  SCRFD_INPUT_SIZE,
  type StrideOutputs,
} from "@/vision/engine/scrfd";

/**
 * Build one head's tensors with a single above-threshold anchor.
 *
 * `distances` are in stride units, exactly as the network emits them, so these
 * fixtures exercise the same arithmetic a real graph would.
 */
function head(
  stride: number,
  rowCount: number,
  hits: Array<{
    row: number;
    score: number;
    distances: [number, number, number, number];
    kps?: number[];
  }>,
): StrideOutputs {
  const scores = new Float32Array(rowCount);
  const bboxes = new Float32Array(rowCount * 4);
  const kps = new Float32Array(rowCount * 10);
  for (const hit of hits) {
    scores[hit.row] = hit.score;
    bboxes.set(hit.distances, hit.row * 4);
    kps.set(hit.kps ?? new Array<number>(10).fill(0), hit.row * 10);
  }
  return { stride, scores, bboxes, kps };
}

function rowsFor(stride: number): number {
  const grid = Math.ceil(SCRFD_INPUT_SIZE / stride);
  return grid * grid * 2;
}

describe("anchorCentres", () => {
  it("lays out two anchors per cell, row-major, both on the cell origin", () => {
    const centres = anchorCentres(SCRFD_INPUT_SIZE, 32);
    const grid = SCRFD_INPUT_SIZE / 32; // 20
    expect(centres.length).toBe(grid * grid * 2 * 2);

    // Cell (0,0): both anchors at (0,0).
    expect([centres[0], centres[1], centres[2], centres[3]]).toEqual([0, 0, 0, 0]);
    // Cell (x=1, y=0) → row index 2.
    expect([centres[4], centres[5]]).toEqual([32, 0]);
    // Cell (x=0, y=1) → row index 2·grid.
    const rowStart = 2 * grid * 2;
    expect([centres[rowStart], centres[rowStart + 1]]).toEqual([0, 32]);
  });

  it("returns the same array for repeated calls", () => {
    // Cached: a scan asks for this once per stride per image, and the answer
    // depends only on (inputSize, stride).
    expect(anchorCentres(SCRFD_INPUT_SIZE, 8)).toBe(anchorCentres(SCRFD_INPUT_SIZE, 8));
  });
});

describe("decodeStride", () => {
  it("turns distance regression into a corner box around the anchor centre", () => {
    // Stride 32, anchor row 2 → cell (x=1, y=0), centre (32, 0).
    const out = head(32, rowsFor(32), [
      { row: 2, score: 0.9, distances: [1, 0.5, 2, 1.5] },
    ]);
    const [detection] = decodeStride(out, SCRFD_INPUT_SIZE, 0.5);
    expect(detection.box).toEqual([32 - 32, 0 - 16, 32 + 64, 0 + 48]);
    expect(detection.score).toBeCloseTo(0.9, 6);
  });

  it("decodes keypoints as signed offsets from the same centre", () => {
    const out = head(16, rowsFor(16), [
      {
        row: 0,
        score: 0.8,
        distances: [1, 1, 1, 1],
        kps: [1, -1, 2, -1, 1.5, 0, 1, 1, 2, 1],
      },
    ]);
    const [detection] = decodeStride(out, SCRFD_INPUT_SIZE, 0.5);
    expect(detection.kps).toEqual([
      [16, -16],
      [32, -16],
      [24, 0],
      [16, 16],
      [32, 16],
    ]);
  });

  it("drops anchors below the score threshold", () => {
    const out = head(32, rowsFor(32), [
      { row: 0, score: 0.49, distances: [1, 1, 1, 1] },
      { row: 1, score: 0.51, distances: [1, 1, 1, 1] },
    ]);
    expect(decodeStride(out, SCRFD_INPUT_SIZE, 0.5)).toHaveLength(1);
  });

  it("refuses more rows than the input size can have anchors for", () => {
    // The failure this guards against — outputs grouped onto the wrong stride —
    // otherwise produces plausible boxes in the wrong places rather than an error.
    const out = head(32, rowsFor(8), []);
    expect(() => decodeStride(out, SCRFD_INPUT_SIZE, 0.5)).toThrow(/exceed/);
  });
});

describe("decodeScrfd", () => {
  it("suppresses the same face found by two different strides", () => {
    // Stride 16 row 0 and stride 32 row 0 both sit on centre (0,0) and describe
    // near-identical boxes. Per-stride NMS would leave both.
    const heads = [
      head(8, rowsFor(8), []),
      head(16, rowsFor(16), [{ row: 0, score: 0.7, distances: [0, 0, 6, 6] }]),
      head(32, rowsFor(32), [{ row: 0, score: 0.95, distances: [0, 0, 3, 3] }]),
    ];
    const detections = decodeScrfd(heads);
    expect(detections).toHaveLength(1);
    expect(detections[0].score).toBeCloseTo(0.95, 6);
  });

  it("keeps genuinely separate faces", () => {
    const heads = [
      head(8, rowsFor(8), []),
      head(16, rowsFor(16), []),
      head(32, rowsFor(32), [
        { row: 0, score: 0.9, distances: [0, 0, 2, 2] },
        // Row 40 → cell (x=0, y=1) at stride 32 with a 20-wide grid: centre (0, 32).
        { row: 2 * 20, score: 0.8, distances: [0, 0, 0.5, 0.5] },
      ]),
    ];
    expect(decodeScrfd(heads)).toHaveLength(2);
  });

  it("returns nothing when every anchor is below threshold", () => {
    const heads = [head(8, rowsFor(8), []), head(16, rowsFor(16), []), head(32, rowsFor(32), [])];
    expect(decodeScrfd(heads)).toEqual([]);
  });
});

describe("groupScrfdOutputs", () => {
  /** A tensor as onnxruntime renders it. */
  const tensor = (rows: number, channels: number) => ({
    dims: [rows, channels],
    data: new Float32Array(rows * channels),
  });

  it("groups by shape, not by output order", () => {
    // Deliberately shuffled: the reference implementation indexes positionally,
    // and a re-exported graph that reordered its outputs would silently decode
    // keypoints as boxes.
    const grouped = groupScrfdOutputs([
      tensor(rowsFor(32), 10),
      tensor(rowsFor(8), 4),
      tensor(rowsFor(16), 1),
      tensor(rowsFor(32), 1),
      tensor(rowsFor(8), 10),
      tensor(rowsFor(16), 4),
      tensor(rowsFor(8), 1),
      tensor(rowsFor(32), 4),
      tensor(rowsFor(16), 10),
    ]);

    expect(grouped.map((g) => g.stride)).toEqual([8, 16, 32]);
    expect(grouped[0].scores.length).toBe(rowsFor(8));
    expect(grouped[0].bboxes.length).toBe(rowsFor(8) * 4);
    expect(grouped[2].kps.length).toBe(rowsFor(32) * 10);
  });

  it("tolerates a leading batch axis", () => {
    const withBatch = (rows: number, channels: number) => ({
      dims: [1, rows, channels],
      data: new Float32Array(rows * channels),
    });
    const grouped = groupScrfdOutputs([
      withBatch(rowsFor(8), 1),
      withBatch(rowsFor(8), 4),
      withBatch(rowsFor(8), 10),
      withBatch(rowsFor(16), 1),
      withBatch(rowsFor(16), 4),
      withBatch(rowsFor(16), 10),
      withBatch(rowsFor(32), 1),
      withBatch(rowsFor(32), 4),
      withBatch(rowsFor(32), 10),
    ]);
    expect(grouped).toHaveLength(3);
  });

  it("names the problem when the graph has no keypoint heads", () => {
    expect(() =>
      groupScrfdOutputs([
        tensor(rowsFor(8), 1),
        tensor(rowsFor(8), 4),
        tensor(rowsFor(16), 1),
        tensor(rowsFor(16), 4),
        tensor(rowsFor(32), 1),
        tensor(rowsFor(32), 4),
      ]),
    ).toThrow(/bnkps/);
  });

  it("rejects an unexpected output width", () => {
    expect(() => groupScrfdOutputs([tensor(rowsFor(8), 7)])).toThrow(/expected 1, 4, or 10/);
  });
});

describe("letterboxScale", () => {
  it("fits the longest side and preserves the aspect ratio", () => {
    expect(letterboxScale(1280, 640, 640)).toBeCloseTo(0.5, 10);
    expect(letterboxScale(640, 1280, 640)).toBeCloseTo(0.5, 10);
    expect(letterboxScale(320, 320, 640)).toBeCloseTo(2, 10);
  });
});
