/**
 * The square library grid, at the geometry this app ships.
 *
 * Asserts against the real constants, which is why `grid-geometry.ts` exists
 * apart from `theme.ts`: it imports no React Native, so a Node test can read it.
 *
 * The container width is a real handset's. A Pixel 5 is 1080 physical pixels at
 * 2.75, so 393 layout points — the whole window, because the grid runs edge to
 * edge. See `libraryGridWidth`.
 */
import { describe, it, expect } from "vitest";
import {
  GRID_GAP,
  libraryColumns,
  libraryGridWidth,
  libraryTileSize,
} from "../src/ui/grid-geometry";

const PORTRAIT = { width: 393, height: 851 };
const LANDSCAPE = { width: 851, height: 393 };

describe("the library grid on a phone", () => {
  it("puts two tiles in a row in portrait", () => {
    expect(libraryColumns(PORTRAIT)).toBe(2);
  });

  it("puts four tiles in a row in landscape", () => {
    expect(libraryColumns(LANDSCAPE)).toBe(4);
  });

  it.each([PORTRAIT, LANDSCAPE])("fills the width exactly, gap included (%o)", (window) => {
    const width = libraryGridWidth(window.width);
    const columns = libraryColumns(window);
    const size = libraryTileSize(width, columns);

    expect(size * columns + GRID_GAP * (columns - 1)).toBeCloseTo(width, 6);
  });

  it("keeps a landscape tile about the size of a portrait one", () => {
    const portrait = libraryTileSize(libraryGridWidth(PORTRAIT.width), libraryColumns(PORTRAIT));
    const landscape = libraryTileSize(libraryGridWidth(LANDSCAPE.width), libraryColumns(LANDSCAPE));

    expect(landscape / portrait).toBeGreaterThan(0.9);
    expect(landscape / portrait).toBeLessThan(1.2);
  });

  it("answers zero for a window that has not been measured", () => {
    expect(libraryTileSize(0, 2)).toBe(0);
  });
});
