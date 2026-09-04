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
 * tile's width into the pixel long edge it asks the ladder for and into how many
 * records a page should hold; `LibraryGrid` turns the row height into rows.
 */

/** The padding the library list carries on each side, in layout points. */
export const CONTENT_PADDING = 20;

/** The gap between tiles, in both axes, in layout points. */
export const GRID_GAP = 2;

/**
 * The height a justified library row aims for, in layout points.
 *
 * ## Why the library grid has a row height and the device grid still has columns
 *
 * They answer different questions. `MediaGrid` shows the camera roll as the
 * media store reports it — a contact sheet, where a square crop is the point
 * because the question is *which of these do I have*. The library shows
 * photographs, and a square crop of a photograph is not the photograph. So the
 * library became justified rows, where every picture in a row shares a height
 * and keeps its own shape, and nothing is ever cropped to a square.
 *
 * That also fixed the sizing. A square tile is the wrong box to measure a
 * rendition request against: a portrait photograph in a square tile is drawn
 * shorter and narrower than the tile, so the request was computed against pixels
 * the picture does not occupy.
 *
 * ## Why 160
 *
 * **Three portraits across a phone, which is what 120 did not give.** A
 * justified row has no column count to set — how many photographs it holds falls
 * out of their shapes — so the row height is the only control there is, and 160
 * is the smallest height at which a row of 3:4 portraits holds three rather than
 * four. At 120 a portrait is 90 points wide, four of them plus their gaps come
 * to 366 against a 353-point container, and `justifiedRows` prefers that
 * overflowing row to the short one it would otherwise cut. At 160 a portrait is
 * 120 points and three of them fit with two points to spare.
 *
 * The height is spent on the other shapes too, which is the trade rather than a
 * side effect: a row of 3:2 landscapes holds two where it used to hold three,
 * and a photograph wide enough fills a row on its own. That is a justified grid
 * spending width on the pictures that can use it, and it is what asking for
 * fewer, larger tiles means.
 *
 * Rows do not hold to this exactly. A row grows or shrinks to fill the width,
 * which is what `justifiedRows` does with the slack; this is the height it aims
 * for. See `photos/render-target.ts` for why the rendition request is measured
 * against this number rather than against the height a row lands on.
 */
export const LIBRARY_ROW_HEIGHT = 160;

/**
 * The width a tile takes in the *device* grid, as a fraction of the row.
 *
 * `MediaGrid`'s, not the library's — the camera-roll contact sheet is still
 * three square tiles across, for the reason {@link LIBRARY_ROW_HEIGHT} gives
 * about the two grids answering different questions.
 */
export const TILE_WIDTH_FRACTION = 0.328;

/**
 * Three across, which is what {@link TILE_WIDTH_FRACTION} is chosen to fit.
 *
 * Named rather than left implicit in the fraction, because the paging arithmetic
 * divides by it and `0.328` does not say "three" to a reader.
 */
export const GRID_COLUMNS = 3;
