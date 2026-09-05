/**
 * One set of styles for the whole shell.
 *
 * Small enough to be a single file, and worth being one: two screens that drift
 * apart visually read as two apps, and this is the first thing anyone sees.
 */

import { StyleSheet } from "react-native";
import { CONTENT_PADDING, GRID_GAP, TILE_WIDTH_FRACTION } from "./grid-geometry";
// The footer's height is geometry the rendition request also reads — the stage
// is the window less the insets less this number — so it lives beside the
// arithmetic rather than beside the style. Two copies of it would let the
// layout and the request disagree about how much room the photograph gets,
// which is exactly the defect the stated height replaced.
import { VIEWER_FOOTER_HEIGHT } from "../photos/render-target";

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
 * The grid's geometry, re-exported so every reader still finds it here.
 *
 * The values live in `grid-geometry.ts`, which imports nothing — this file calls
 * `StyleSheet.create`, so anything defined here is unreachable from a Node test.
 * See that file for what each number is and why.
 */
export {
  CONTENT_PADDING,
  GRID_COLUMNS,
  GRID_GAP,
  LIBRARY_ROW_HEIGHT,
  libraryGridWidth,
  TILE_WIDTH_FRACTION,
} from "./grid-geometry";

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
   * The list's own padding, without `content`'s gap and without side padding.
   *
   * `content` separates the screen's sections by 20; applied to a list it would
   * separate every grid row by 20 as well. The sections keep their spacing by
   * carrying it on the header and footer instead.
   *
   * Vertical only, because the grid runs the full width of the screen. What
   * needs the side inset is the text around the grid, which takes it from
   * `listGutter`.
   */
  listContent: { paddingVertical: CONTENT_PADDING },
  /**
   * The side inset the list's text carries, now that the list itself does not.
   *
   * The header, the footer and the empty message; never a grid row.
   */
  listGutter: { paddingHorizontal: CONTENT_PADDING },
  tile: {
    width: `${TILE_WIDTH_FRACTION * 100}%`,
    aspectRatio: 1,
    backgroundColor: colors.surface,
    justifyContent: "flex-end",
  },
  /**
   * One tile of the justified library grid.
   *
   * No `width` and no `aspectRatio`, unlike `tile` above: the layout assigns
   * both per photograph, so a style that carried either would be a second
   * opinion about the shape and the two would disagree on every row.
   */
  justifiedTile: { backgroundColor: colors.surface, justifyContent: "flex-end" },
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
  /**
   * The mark on a tile with no bytes here at all, over whatever is behind it.
   *
   * Absolutely positioned rather than a replacement for the image, because the
   * image is no longer absent when the bytes are: a ThumbHash paints under this,
   * and the mark says the full picture is still owed. Drawing this *instead* of
   * the image — which is what the grid used to do — would have thrown the
   * placeholder away in the one case it exists for.
   */
  tileMissingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  tilePlaceholderMark: { color: colors.border, fontSize: 22 },

  /**
   * The viewer's own surface, over the screen that opened it.
   *
   * Absolute rather than a `Modal`, which is what stops this costing a second
   * view hierarchy and a window animation for a surface the app already owns —
   * and what keeps the grid mounted underneath, so returning to it costs no
   * scroll position and no re-decoded tiles. It sits inside `HomeScreen`'s own
   * `SafeAreaView`, so its box is the window less the system insets, which is
   * exactly what `viewerStageBox` subtracts.
   */
  viewerOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#000",
  },
  // The viewer deliberately goes black rather than using the app background:
  // a photograph is the only thing on screen and every other pixel should get
  // out of its way.
  viewerSafe: { flex: 1, backgroundColor: "#000" },
  /**
   * The swipe wrapper around the still, and deliberately nothing but `flex`.
   *
   * `viewerImageArea` centres on both axes, and a parent that centres sizes its
   * child to the child's own content rather than stretching it. Giving the
   * wrapper that style collapsed the `Pressable` inside it to zero width, which
   * made `viewerImage` resolve to zero — a full-screen photograph that never
   * loaded, because `expo-image` does not fetch for a view with no size.
   */
  viewerStage: { flex: 1 },
  viewerImageArea: { flex: 1, alignItems: "center", justifyContent: "center" },
  /**
   * One rung, filling the stage.
   *
   * Absolute so that several can occupy the same box at once: an upgrade mounts
   * the incoming rung over the outgoing one and swaps opacity when it has
   * rendered, and two layers that took part in the layout would push each other
   * around instead of overlapping. Both draw `contain` in an identical box, so
   * the picture is in exactly the same place at every resolution. See
   * `StillStage` in `LibraryViewer.tsx`.
   */
  viewerImage: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  /**
   * The footer, at the height the stage arithmetic reserved for it.
   *
   * Stated rather than grown, because the stage is computed as the window less
   * the insets less exactly this number — and a footer that took more or less
   * than it was given would resize the picture above it. `VIEWER_FOOTER_HEIGHT`
   * is the number and `photos/render-target.ts` argues for it.
   */
  viewerFooter: {
    height: VIEWER_FOOTER_HEIGHT,
    padding: 20,
    gap: 4,
    backgroundColor: colors.background,
  },
  /**
   * The pixel-count readout, over the photograph rather than under it.
   *
   * Absolute so it takes no room: the footer is what sizes the stage, and a
   * readout that grew the footer would change the very numbers it reports. See
   * `RenderedSize` in `LibraryViewer.tsx`.
   */
  renderedSize: {
    position: "absolute",
    top: 8,
    left: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  renderedSizeText: { color: "#ddd", fontSize: 11, fontFamily: "monospace" },

  row: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  rowText: { flex: 1, gap: 2 },
  badge: { fontSize: 11, fontWeight: "700", paddingTop: 3, width: 34 },
  ok: { color: colors.accent },
  bad: { color: colors.danger },
  /** For a check that failed without anything being wrong — see `Check.required`. */
  info: { color: colors.muted },
});
