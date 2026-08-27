import { describe, expect, it } from "vitest";
import { justifiedRows } from "../src/photos-ui/components/grid/justified-layout";

interface Photo {
  id: string;
  aspect: number;
}

const aspectOf = (photo: Photo) => photo.aspect;

function photos(...aspects: number[]): Photo[] {
  return aspects.map((aspect, index) => ({ id: `p${index}`, aspect }));
}

const OPTIONS = { containerWidth: 1200, targetRowHeight: 200, gap: 4 };

function rowWidth(widths: number[], gap: number): number {
  return widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
}

describe("justifiedRows", () => {
  it("fills the container width exactly on every row but the last", () => {
    const rows = justifiedRows(photos(1.5, 0.75, 1.5, 1.33, 1, 1.5, 2, 0.75, 1.5), aspectOf, OPTIONS);
    expect(rows.length).toBeGreaterThan(1);

    for (const row of rows.slice(0, -1)) {
      const widths = row.placements.map((placement) => placement.width);
      expect(rowWidth(widths, OPTIONS.gap)).toBeCloseTo(OPTIONS.containerWidth, 6);
    }
  });

  it("scales every photo in a row to the same height", () => {
    const rows = justifiedRows(photos(2, 0.5, 1.5, 1, 1.33, 3, 0.75), aspectOf, OPTIONS);
    for (const row of rows) {
      expect(row.height).toBeGreaterThan(0);
      // The row's height is a single number, so sameness is structural; what is
      // worth asserting is that it stays at or below what was asked for.
      expect(row.height).toBeLessThanOrEqual(OPTIONS.targetRowHeight + 1e-9);
    }
  });

  it("crops every photo in a row by the same fraction of its own width", () => {
    const rows = justifiedRows(photos(2, 0.5, 1.5, 1, 1.33, 3, 0.75), aspectOf, OPTIONS);
    const row = rows[0];
    expect(row.cropScale).toBeLessThan(1);

    for (const { item, width } of row.placements) {
      // Uncropped, the photo would be aspect × height wide; the box it is drawn
      // in is that width times the row's single crop fraction.
      const uncropped = item.aspect * row.height;
      // Widths are whole pixels and the last box absorbs the rounding residual,
      // so the shared fraction holds to within a pixel rather than exactly.
      expect(Math.abs(width - uncropped * row.cropScale)).toBeLessThanOrEqual(1);
    }
  });

  it("leaves an underfilled final row uncropped and short of the container", () => {
    const rows = justifiedRows(photos(1.5, 1.5, 1.5, 1.5, 1.5, 0.75), aspectOf, OPTIONS);
    const last = rows[rows.length - 1];

    expect(last.cropScale).toBe(1);
    expect(last.height).toBe(OPTIONS.targetRowHeight);
    for (const { item, width } of last.placements) {
      expect(width).toBeCloseTo(item.aspect * OPTIONS.targetRowHeight, 6);
    }
    expect(rowWidth(last.placements.map((p) => p.width), OPTIONS.gap)).toBeLessThan(OPTIONS.containerWidth);
  });

  it("shows a single photo narrower than the container uncropped", () => {
    const rows = justifiedRows(photos(1.5), aspectOf, OPTIONS);
    expect(rows).toHaveLength(1);
    expect(rows[0].cropScale).toBe(1);
    expect(rows[0].placements[0].width).toBeCloseTo(300, 6);
  });

  it("shortens a row rather than cutting most of a panorama away", () => {
    // A 10:1 panorama is 2000 px wide at the requested height and would have to
    // lose 40% of itself to fit 1200 px. The cap keeps the crop at 30% and pays
    // for it with a shorter row.
    const rows = justifiedRows(photos(10, 1.5, 1.5), aspectOf, OPTIONS);
    const row = rows[0];

    expect(row.placements).toHaveLength(1);
    expect(row.cropScale).toBeCloseTo(0.7, 6);
    expect(row.height).toBeLessThan(OPTIONS.targetRowHeight);
    expect(rowWidth(row.placements.map((p) => p.width), OPTIONS.gap)).toBeCloseTo(1200, 6);
  });

  it("accounts for the gaps between photos when filling the width", () => {
    // Six 1:1 photos at 200 px are 1200 px of photo, which fills the container
    // only if the gaps take no room — so the row must crop.
    const rows = justifiedRows(photos(1, 1, 1, 1, 1, 1), aspectOf, OPTIONS);
    expect(rows).toHaveLength(1);
    expect(rows[0].cropScale).toBeLessThan(1);
    expect(rowWidth(rows[0].placements.map((p) => p.width), OPTIONS.gap)).toBeCloseTo(1200, 6);
  });

  it("lays nothing out before the container has been measured", () => {
    expect(justifiedRows(photos(1.5, 1.5), aspectOf, { ...OPTIONS, containerWidth: 0 })).toEqual([]);
    expect(justifiedRows([], aspectOf, OPTIONS)).toEqual([]);
  });
});
