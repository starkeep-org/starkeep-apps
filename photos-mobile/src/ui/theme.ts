/**
 * One set of styles for the whole shell.
 *
 * Small enough to be a single file, and worth being one: two screens that drift
 * apart visually read as two apps, and this is the first thing anyone sees.
 */

import { StyleSheet } from "react-native";
import { CONTENT_PADDING, GRID_GAP } from "./grid-geometry";
// The viewer's bar height is geometry the rendition request also reads — the
// stage is the window less the insets less both bars — so it lives beside the
// arithmetic rather than beside the style. Two copies of it would let the
// layout and the request disagree about how much room the photograph gets.
import { VIEWER_BAR_HEIGHT } from "../photos/render-target";

/** The height of the grid's app bar, below the status bar. */
export const APP_BAR_HEIGHT = 56;

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
  GRID_GAP,
  libraryColumns,
  libraryGridWidth,
  libraryTileSize,
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

  /**
   * One row of the library grid, as a virtualized list item. `marginBottom`
   * rather than a container `gap`, because the list puts nothing between its
   * items.
   */
  gridRow: { flexDirection: "row", gap: GRID_GAP, marginBottom: GRID_GAP },
  /**
   * The side inset the list's text carries, now that the list itself does not.
   *
   * The access prompt and the empty message; never a grid row.
   */
  listGutter: { paddingHorizontal: CONTENT_PADDING },
  /**
   * One square tile of the library grid.
   *
   * No `width` and no `height`: `LibraryRow` sets both from `libraryTileSize`,
   * the same number the rendition request is measured against.
   */
  gridTile: { backgroundColor: colors.surface, justifyContent: "flex-end" },
  tileImage: { width: "100%", height: "100%" },
  /**
   * The mark on a video tile. See `VideoBadge.tsx`.
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
   * The app bar over the grid: the menu button and the title, below the status
   * bar. Landscape hides it, so the grid has the whole screen.
   */
  appBar: {
    height: APP_BAR_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
    gap: 4,
    backgroundColor: colors.background,
  },
  appBarTitle: { color: colors.heading, fontSize: 20, fontWeight: "600" },
  /** A 48-point touch target around a 24-point icon. */
  iconButton: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  /** The menu the hamburger opens, anchored under the app bar's left edge. */
  menuBackdrop: { flex: 1 },
  menu: {
    position: "absolute",
    left: 8,
    minWidth: 180,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    elevation: 8,
  },
  menuItem: { paddingHorizontal: 16, paddingVertical: 12 },
  menuItemLabel: { color: colors.text, fontSize: 16 },

  /**
   * A full-screen surface over the grid: the viewer and Settings.
   *
   * Absolute rather than a `Modal`, which is what stops this costing a second
   * view hierarchy and a window animation for a surface the app already owns —
   * and what keeps the grid mounted underneath, so returning to it costs no
   * scroll position and no re-decoded tiles. It sits at the root of
   * `HomeScreen`, outside any safe-area padding, so its box is the whole window
   * and it applies the insets itself.
   */
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.background,
  },
  // The viewer deliberately goes black rather than using the app background:
  // a photograph is the only thing on screen and every other pixel should get
  // out of its way.
  viewerOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#000",
  },
  /**
   * The viewer's top bar and footer, at the height the stage arithmetic
   * reserved for each.
   *
   * Stated rather than grown, because the stage is computed as the window less
   * the insets less exactly these two numbers — and a bar that took more or less
   * than it was given would resize the picture between them. The focused view
   * hides a bar's controls and leaves the bar.
   */
  viewerTopBar: {
    height: VIEWER_BAR_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
  },
  viewerFooter: {
    height: VIEWER_BAR_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
  },
  /** The landscape back arrow, floating over the stage's top-left corner. */
  viewerFloatingBack: { position: "absolute", top: 8 },
  viewerMotionLabel: { color: "#fff", fontSize: 14 },
  /** One page of the pager: the stage, centred in a page as wide as the window. */
  viewerPage: { alignItems: "center", justifyContent: "center" },
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
   * The play control over a clip's poster: a disc in the middle of the stage.
   * Absolute over the poster rather than beside it, so the stage keeps the box
   * the poster was laid out in.
   */
  viewerPlayButton: {
    position: "absolute",
    alignSelf: "center",
    top: "50%",
    marginTop: -36,
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  viewerPlayBusy: { color: "#fff", fontSize: 12 },
  /** The info sheet: a panel rising from the bottom over a dimmed viewer. */
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: {
    maxHeight: "75%",
    backgroundColor: colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: CONTENT_PADDING,
    paddingTop: 8,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sheetTitle: { color: colors.heading, fontSize: 16, fontWeight: "600" },
  infoRow: { flexDirection: "row", gap: 12, paddingVertical: 6 },
  infoLabel: { color: colors.muted, fontSize: 13, width: 110 },
  infoValue: { color: colors.text, fontSize: 13, flex: 1 },
  infoValueMono: { color: colors.text, fontSize: 12, flex: 1, fontFamily: "monospace" },
  sheetDelete: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  sheetDeleteLabel: { color: colors.danger, fontSize: 15, fontWeight: "600" },

  row: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  /** A row of mutually exclusive choices, such as the photo ceiling. */
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipSelected: { backgroundColor: colors.text, borderColor: colors.text },
  chipLabel: { color: colors.text, fontSize: 13 },
  chipLabelSelected: { color: colors.background, fontSize: 13, fontWeight: "600" },
  rowText: { flex: 1, gap: 2 },
});
