/**
 * How many photographs a library row holds, at the height this app ships.
 *
 * ## Why this asserts against the real constant
 *
 * `LIBRARY_ROW_HEIGHT` is the only control a justified grid has over how many
 * pictures land in a row — there is no column count to set, because the count
 * falls out of the shapes. So "three portraits across" is not a property of the
 * layout, it is a property of the layout *at this height on this width*, and a
 * test with its own fixed geometry would assert nothing about what the app draws.
 *
 * That is why `grid-geometry.ts` exists apart from `theme.ts`: the constant is
 * importable here because it is defined in a file that pulls in no React Native.
 *
 * The container width is a real handset's, and stated rather than derived. A
 * Pixel 5 is 1080 physical pixels at 2.75, so 393 layout points, less the 20
 * points of padding the list carries on each side.
 */
import { describe, it, expect } from "vitest";
import { CONTENT_PADDING, GRID_GAP, LIBRARY_ROW_HEIGHT } from "../src/ui/grid-geometry";
import { layOutRows } from "../src/photos/render-target";

const PIXEL_5_WIDTH = 393;
const CONTAINER = PIXEL_5_WIDTH - CONTENT_PADDING * 2;

const PORTRAIT = 3 / 4;
const LANDSCAPE = 3 / 2;

function rowsOf(aspect: number, count: number, targetRowHeight = LIBRARY_ROW_HEIGHT) {
  const items = Array.from({ length: count }, (_, index) => ({ index, aspect }));
  return layOutRows(items, (item) => item.aspect, {
    containerWidth: CONTAINER,
    targetRowHeight,
    gap: GRID_GAP,
  });
}

describe("a row of portraits on a phone", () => {
  it("holds three at the shipped row height", () => {
    // Every row but the last, which is underfilled by design — `justifiedRows`
    // leaves a trailing row short rather than stretching it, because a stretched
    // row lies about the shapes.
    const rows = rowsOf(PORTRAIT, 12);
    const full = rows.slice(0, -1);

    expect(full.length).toBeGreaterThan(0);
    for (const row of full) expect(row.placements).toHaveLength(3);
  });

  it("held four at the height this replaced, which is the regression", () => {
    // The measured symptom, kept as a case so the constant cannot quietly go
    // back. At 120 a portrait is 90 points wide and four of them plus their gaps
    // come to 366 against a 353-point container; the layout's strain rule
    // prefers that overflowing row to the short one it would otherwise cut.
    const rows = rowsOf(PORTRAIT, 12, 120);

    expect(rows[0]?.placements).toHaveLength(4);
  });
});

describe("the height a row of portraits is spent on", () => {
  it("gives landscapes two across rather than three", () => {
    // Stated because it is the trade rather than a side effect: the same height
    // that makes a portrait row three long makes a 3:2 row two long. A justified
    // grid spends width on the pictures that can use it.
    const rows = rowsOf(LANDSCAPE, 12);
    const full = rows.slice(0, -1);

    expect(full.length).toBeGreaterThan(0);
    for (const row of full) expect(row.placements).toHaveLength(2);
  });
});

describe("what a row asks the tile to draw", () => {
  it("hands back boxes narrower than the photographs when it crops", () => {
    // The reason the tile paints `contentFit="cover"`. A row that overflows
    // spends a crop budget before it spends height, so the box a placement
    // carries is narrower than the photograph's own width at that height —
    // `contain` would refuse that crop and letterbox the picture vertically
    // instead, which is what made the gap between rows look uneven.
    const cropped = rowsOf(PORTRAIT, 12).filter((row) => row.cropScale < 1);

    expect(cropped.length).toBeGreaterThan(0);
    for (const row of cropped) {
      for (const placement of row.placements) {
        expect(placement.width).toBeLessThan(row.height * PORTRAIT);
      }
    }
  });
});
