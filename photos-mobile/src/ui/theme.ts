/**
 * One set of styles for the whole shell.
 *
 * Small enough to be a single file, and worth being one: two screens that drift
 * apart visually read as two apps, and this is the first thing anyone sees.
 */

import { StyleSheet } from "react-native";

export const colors = {
  background: "#111",
  surface: "#1a1a1a",
  text: "#eee",
  heading: "#fff",
  muted: "#888",
  border: "#2a2a2a",
  accent: "#4ade80",
  danger: "#f87171",
} as const;

/**
 * The grid's geometry, named because several things outside the stylesheet need
 * it.
 *
 * `use-library.ts` converts a tile's width into the pixel long edge it asks the
 * ladder for and into how many records a page should hold; `LibraryGrid` turns
 * a row height into the `getItemLayout` the virtualized list needs. A second
 * copy of any of these numbers would drift from the layout silently — the tiles
 * would keep rendering and simply request the wrong rung, or the list would
 * scroll to the wrong offset.
 */
export const CONTENT_PADDING = 20;
export const TILE_WIDTH_FRACTION = 0.328;
/**
 * Three across, which is what `TILE_WIDTH_FRACTION` is chosen to fit.
 *
 * Named rather than left implicit in the fraction, because the row-building and
 * paging arithmetic both divide by it and `0.328` does not say "three" to a
 * reader.
 */
export const GRID_COLUMNS = 3;
/** The gap `styles.grid` puts between tiles, in both axes. */
export const GRID_GAP = 2;

export const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: CONTENT_PADDING, gap: 20 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },

  title: { color: colors.heading, fontSize: 28, fontWeight: "600" },
  subtitle: { color: colors.muted, fontSize: 14 },
  sectionTitle: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  section: { gap: 8 },
  body: { color: colors.text, fontSize: 15 },
  muted: { color: colors.muted, fontSize: 13 },
  mono: { color: "#ccc", fontSize: 12, fontFamily: "monospace" },
  error: { color: colors.danger, fontSize: 13 },

  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },

  button: {
    backgroundColor: colors.text,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.4 },
  buttonLabel: { color: colors.background, fontSize: 16, fontWeight: "600" },
  linkLabel: { color: colors.muted, fontSize: 14 },

  // Three across, by percentage rather than a measured width: the tiles then
  // survive a rotation and a tablet without anyone measuring the screen.
  grid: { flexDirection: "row", flexWrap: "wrap", gap: GRID_GAP },
  /**
   * One row of the library grid, as a virtualized list item.
   *
   * Its own style rather than a reuse of `grid`, because the two lay out
   * differently now: `grid` wraps a whole set of tiles and is what the device
   * grid still uses, and this is a single row whose height the list computes in
   * advance. `marginBottom` rather than a container `gap`, because the list puts
   * nothing between its items.
   */
  gridRow: { flexDirection: "row", gap: GRID_GAP, marginBottom: GRID_GAP },
  /**
   * The list's own padding, without `content`'s gap.
   *
   * `content` separates the screen's sections by 20; applied to a list it would
   * separate every grid row by 20 as well. The sections keep their spacing by
   * carrying it on the header and footer instead.
   */
  listContent: { padding: CONTENT_PADDING },
  tile: {
    width: `${TILE_WIDTH_FRACTION * 100}%`,
    aspectRatio: 1,
    backgroundColor: colors.surface,
    justifyContent: "flex-end",
  },
  tileImage: { width: "100%", height: "100%" },
  /**
   * A device asset this node does not hold.
   *
   * Dimmed rather than badged alone, because the question somebody opens the
   * device grid to answer is "which ones are missing" — and scanning sixty
   * tiles for a small mark is not answering it. The mark beside this says which
   * state the dimming means, since a faded tile on its own reads as one still
   * loading.
   */
  tileNotImported: { opacity: 0.35 },
  tileMissingMark: {
    position: "absolute",
    bottom: 3,
    left: 3,
    right: 3,
    color: colors.danger,
    fontSize: 9,
    fontWeight: "700",
    textAlign: "center",
  },
  /**
   * The mark on a video tile, in both grids. See `VideoBadge.tsx`.
   *
   * Top right rather than bottom right, which is where the device grid used to
   * put a bare duration. The bottom of a tile is where a photograph's subject
   * most often is, and the top right is the corner every other photos app on the
   * device reserves for exactly this.
   *
   * No backdrop, so this leans on the shadow to stay legible over a bright
   * frame — cheaper than a gradient and enough at this size.
   */
  /**
   * The corner mark a tile carries: `▶ 0:42` on a clip, `◉ motion` on a Motion
   * Photo. One style for both, because a tile never carries both — a Motion
   * Photo is an image record — and two marks in the same corner drawn two ways
   * would read as two unrelated features.
   */
  tileBadge: {
    position: "absolute",
    right: 4,
    top: 4,
    color: "#fff",
    fontSize: 10,
    fontWeight: "600",
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowRadius: 3,
  },

  /** A record this node has but whose bytes are elsewhere. Not an error state. */
  tilePlaceholder: { alignItems: "center", justifyContent: "center" },
  tilePlaceholderMark: { color: colors.border, fontSize: 22 },

  // The viewer deliberately goes black rather than using the app background:
  // a photograph is the only thing on screen and every other pixel should get
  // out of its way.
  viewerSafe: { flex: 1, backgroundColor: "#000" },
  viewerImageArea: { flex: 1, alignItems: "center", justifyContent: "center" },
  viewerImage: { width: "100%", height: "100%" },
  viewerFooter: { padding: 20, gap: 4, backgroundColor: colors.background },

  row: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  rowText: { flex: 1, gap: 2 },
  badge: { fontSize: 11, fontWeight: "700", paddingTop: 3, width: 34 },
  ok: { color: colors.accent },
  bad: { color: colors.danger },
  /** For a check that failed without anything being wrong — see `Check.required`. */
  info: { color: colors.muted },
});
