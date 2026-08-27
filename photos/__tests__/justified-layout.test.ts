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

const DESKTOP = { containerWidth: 1200, targetRowHeight: 320, gap: 4 };
/** A 390 px phone, edge to edge, at the mobile default row height. */
const PHONE = { containerWidth: 390, targetRowHeight: 180, gap: 4 };

/** The contract: no photo ever loses more than a tenth of its width. */
const MAX_CROP = 0.1;

function rowWidth(row: { placements: Array<{ width: number }> }, gap: number): number {
  return (
    row.placements.reduce((sum, placement) => sum + placement.width, 0) +
    gap * (row.placements.length - 1)
  );
}

describe("justifiedRows", () => {
  it("fills the container width exactly on every row but the last", () => {
    const rows = justifiedRows(photos(1.5, 0.75, 1.5, 1.33, 1, 1.5, 2, 0.75, 1.5), aspectOf, DESKTOP);
    expect(rows.length).toBeGreaterThan(1);

    for (const row of rows.slice(0, -1)) {
      expect(rowWidth(row, DESKTOP.gap)).toBeCloseTo(DESKTOP.containerWidth, 6);
    }
  });

  it("never crops a photo by more than a tenth of its width", () => {
    // Swept rather than spot-checked, because the crop used to blow out at
    // exactly the shapes and widths nobody thought to write a case for.
    const shapes = [0.5, 0.67, 0.75, 1, 1.33, 1.5, 1.78, 2, 3, 10];
    for (const containerWidth of [320, 390, 430, 768, 1200, 1600]) {
      for (const targetRowHeight of [100, 180, 240, 320, 480]) {
        const spread = Array.from({ length: 40 }, (_, i) => shapes[(i * 7) % shapes.length]);
        const rows = justifiedRows(photos(...spread), aspectOf, {
          containerWidth,
          targetRowHeight,
          gap: 4,
        });
        for (const row of rows) {
          expect(
            1 - row.cropScale,
            `crop at ${containerWidth}x${targetRowHeight}, ${row.placements.length} photos`,
          ).toBeLessThanOrEqual(MAX_CROP + 1e-9);
        }
      }
    }
  });

  it("keeps two ordinary landscape photos on a phone within the crop budget", () => {
    // The reported case. Two 3:2 photos are 540 px wide at the 180 px target
    // against 386 px of usable width, and the old rule spent the whole
    // difference on the crop: 28.5% off each photo.
    const rows = justifiedRows(photos(1.5, 1.5, 1.5, 1.5), aspectOf, PHONE);
    for (const row of rows.slice(0, -1)) {
      expect(1 - row.cropScale).toBeLessThanOrEqual(MAX_CROP + 1e-9);
      expect(rowWidth(row, PHONE.gap)).toBeCloseTo(PHONE.containerWidth, 6);
    }
  });

  it("crops every photo in a row by the same fraction of its own width", () => {
    const rows = justifiedRows(photos(2, 0.5, 1.5, 1, 1.33, 3, 0.75), aspectOf, DESKTOP);
    const cropped = rows.find((row) => row.cropScale < 1);
    expect(cropped).toBeDefined();

    for (const { item, width } of cropped!.placements) {
      // Uncropped, the photo would be aspect × height wide; the box it is drawn
      // in is that width times the row's single crop fraction. Widths are whole
      // pixels and the last box absorbs the rounding residual, so the shared
      // fraction holds to within a pixel rather than exactly.
      const uncropped = item.aspect * cropped!.height;
      expect(Math.abs(width - uncropped * cropped!.cropScale)).toBeLessThanOrEqual(1);
    }
  });

  it("grows a row that would otherwise stop short rather than cropping to fill", () => {
    // Two 16:9 photos overflow a phone badly enough that one photo per row,
    // scaled up, bends less than two photos squeezed in.
    const rows = justifiedRows(photos(16 / 9, 16 / 9, 16 / 9), aspectOf, PHONE);
    const first = rows[0];

    expect(first.placements).toHaveLength(1);
    expect(first.cropScale).toBe(1);
    expect(first.height).toBeGreaterThan(PHONE.targetRowHeight);
    expect(rowWidth(first, PHONE.gap)).toBeCloseTo(PHONE.containerWidth, 6);
  });

  it("draws a panorama at the height its own shape implies rather than cutting it down", () => {
    // A 10:1 photo across a 390 px phone is about 39 px tall. That is not a
    // degenerate row — it is what the photo looks like at that width, and the
    // only way to make it taller is to stop showing most of it.
    const rows = justifiedRows(photos(10, 1.5, 1.5), aspectOf, PHONE);
    const panorama = rows[0];

    expect(panorama.placements).toHaveLength(1);
    expect(1 - panorama.cropScale).toBeLessThanOrEqual(MAX_CROP + 1e-9);
    expect(panorama.height).toBeLessThan(PHONE.targetRowHeight / 2);
    expect(rowWidth(panorama, PHONE.gap)).toBeCloseTo(PHONE.containerWidth, 6);
  });

  it("leaves an underfilled final row uncropped and at the requested height", () => {
    // Four 3:2 photos pack three into the first row and leave one over.
    const rows = justifiedRows(photos(1.5, 1.5, 1.5, 1.5), aspectOf, DESKTOP);
    const last = rows[rows.length - 1];

    expect(rows).toHaveLength(2);
    expect(last.placements).toHaveLength(1);

    expect(last.cropScale).toBe(1);
    expect(last.height).toBe(DESKTOP.targetRowHeight);
    for (const { item, width } of last.placements) {
      expect(width).toBeCloseTo(item.aspect * DESKTOP.targetRowHeight, 6);
    }
    expect(rowWidth(last, DESKTOP.gap)).toBeLessThan(DESKTOP.containerWidth);
  });

  it("shows a single photo narrower than the container uncropped", () => {
    const rows = justifiedRows(photos(1.5), aspectOf, DESKTOP);
    expect(rows).toHaveLength(1);
    expect(rows[0].cropScale).toBe(1);
    expect(rows[0].placements[0].width).toBeCloseTo(480, 6);
  });

  it("accounts for the gaps between photos when filling the width", () => {
    // Six 1:1 photos at 200 px are 1200 px of photo, which fills the container
    // only if the gaps take no room — so something has to give.
    const rows = justifiedRows(photos(1, 1, 1, 1, 1, 1), aspectOf, {
      ...DESKTOP,
      targetRowHeight: 200,
    });
    expect(rows).toHaveLength(1);
    expect(rowWidth(rows[0], DESKTOP.gap)).toBeCloseTo(1200, 6);
  });

  it("lays nothing out before the container has been measured", () => {
    expect(justifiedRows(photos(1.5, 1.5), aspectOf, { ...DESKTOP, containerWidth: 0 })).toEqual([]);
    expect(justifiedRows([], aspectOf, DESKTOP)).toEqual([]);
  });
});
