/**
 * The numbers the library grid is laid out from.
 *
 * ## Why they are not in `theme.ts`
 *
 * They were, and two test files carried a comment apologising for restating
 * them: `theme.ts` calls `StyleSheet.create`, so importing it pulls in React
 * Native, which does not parse under Node. A constant that no test may import is
 * a constant every test hardcodes, and the copies drift from the layout silently
 * — the grid keeps rendering and simply asks for the wrong rung.
 *
 * So the geometry moved to a file with no imports at all. `theme.ts` re-exports
 * every name below, which is why nothing that used to read them from there had
 * to change.
 *
 * Several things outside the stylesheet need these. `use-library.ts` turns a
 * tile's size into the pixel long edge it asks the ladder for and into how many
 * records a page should hold; `LibraryGrid` turns the column count into rows.
 */

/**
 * The padding the list's text carries on each side, in layout points.
 *
 * The header, the footer and the empty message, not the grid: the rows run the
 * full width of the screen. See {@link libraryGridWidth}.
 */
export const CONTENT_PADDING = 20;

/**
 * The width the library rows fill: the whole window.
 *
 * The list used to inset the grid by `CONTENT_PADDING` on each side, which cost
 * 40 points of a 393-point handset — a tenth of the screen spent on a margin,
 * paid for out of the photographs. The text around the grid still carries that
 * inset, because a line of prose that starts at the edge is harder to read; a
 * photograph that reaches the edge is not.
 *
 * A function rather than the bare window width at each call site, so the rule
 * has one place to live and the rendition sizing in `use-library.ts` measures
 * against the same width the rows are laid out in.
 */
export function libraryGridWidth(windowWidth: number): number {
  return windowWidth;
}

/** The gap between tiles, in both axes, in layout points. */
export const GRID_GAP = 2;

/**
 * How many square tiles the library grid puts in a row: two in portrait, four
 * in landscape.
 *
 * Each tile is a centre crop of its photograph. A square grid gives every tile
 * the same box, so a row never changes shape when a page is appended or a
 * record is deleted. Four across a landscape window keeps a tile about the size
 * it is in portrait, so a rotation neither blows the photographs up nor asks
 * for a larger rung.
 */
export function libraryColumns(window: { readonly width: number; readonly height: number }): number {
  return window.width > window.height ? 4 : 2;
}

/**
 * The side of one square tile, in layout points, for a grid this wide.
 *
 * One function for the layout, the rendition request and the paging estimate,
 * so all three measure the same box.
 */
export function libraryTileSize(gridWidth: number, columns: number): number {
  return Math.max(0, (gridWidth - GRID_GAP * (columns - 1)) / columns);
}
