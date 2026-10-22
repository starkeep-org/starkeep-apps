/**
 * How many pixels each surface on this phone is about to paint.
 *
 * ## Why this file exists rather than arithmetic at the call sites
 *
 * Every Photos surface asks the ladder for a *pixel count* and lets the ladder
 * pick a rung. The phone was the one surface that computed its count with its
 * own arithmetic: a fixed width fraction of a fixed three-column grid, times the
 * device pixel ratio. That produced a number, and it was not the number the rule
 * produces — it never asked what shape the photograph was, and it had no answer
 * at all for the viewer, which requested nothing and painted whatever the grid
 * had resolved. A full-screen photograph therefore showed a 320 or 640 pixel
 * rendition.
 *
 * `measuredPhysicalLongEdge` and `canonicalTarget` are the rule, they are shared
 * in `@starkeep/photos-ladder`, and this file is the two calls that apply them
 * to this device's two surfaces.
 *
 * ## Why the grid measures `cover` and the viewer `contain`
 *
 * The grid draws every photograph as a centre crop of a square tile, so the
 * photograph's short edge spans the tile and its long edge overflows it. The
 * rung has to cover that overflowing long edge, or the visible crop is
 * upscaled. The viewer never crops, so it asks for the box the photograph fits
 * inside.
 *
 * ## Why this file may name the ladder
 *
 * It is in `src/photos/`, the one directory that owns Photos' vocabulary on this
 * device. `__tests__/ladder-boundary.test.ts` is what keeps the geometry helpers
 * out of the UI files — a component that imported them would be a component that
 * has to change when the ladder is respecified.
 */

import {
  canonicalMeasuredTarget,
  currentRenditionPolicies,
  displayedAspect,
  measuredPhysicalLongEdge,
  type Dimensions,
} from "@starkeep/photos-ladder";

export type { Dimensions };

/**
 * The grid's geometry, in layout points, plus the display density.
 *
 * Points and not pixels, because that is what React Native's `Dimensions` and
 * the style sheet both work in. The conversion happens once, inside
 * `measuredPhysicalLongEdge`, which is the only place that should know the
 * difference.
 */
export interface GridGeometry {
  /** The side of one square tile. See `libraryTileSize`. */
  readonly tileSize: number;
  readonly devicePixelRatio: number;
}

/**
 * The pixel long edge one grid tile wants, or null when the box is unusable.
 *
 * Measured with `cover` against the square tile, because the tile shows a
 * centre crop. See the file comment.
 *
 * Null rather than a guess for a grid that has not been measured — a zero
 * width is a screen that has not laid out yet, and resolving against it would
 * pin every record on the page to the bottom rung.
 */
export function gridTileTarget(
  source: Dimensions | null,
  orientation: number | null,
  grid: GridGeometry,
): number | null {
  return snap(
    measuredPhysicalLongEdge({
      source,
      container: { width: grid.tileSize, height: grid.tileSize },
      orientation,
      fit: "cover",
      devicePixelRatio: grid.devicePixelRatio,
    }),
  );
}

/**
 * The height of each of the viewer's two bars, in layout points: the top bar
 * with the back arrow and the footer with the info button and the Motion Photo
 * toggle.
 *
 * ## Why a stated height rather than a measurement
 *
 * A bar whose height is whatever its controls happen to need changes height
 * when a control appears, and the motion control appears a second after the
 * viewer opens — so the stage would resize under a picture already on screen,
 * and `expo-image` reissues its whole load whenever the view it draws into
 * changes size. One late control would cost a second full-screen decode.
 *
 * So the height is decided here instead. Each bar is given exactly this much, a
 * control that is absent leaves its space empty, and a control the focused view
 * hides goes transparent rather than leaving the layout. Nothing above or below
 * the stage can then change the stage.
 *
 * ## Why both bars share one height
 *
 * The photograph sits in the middle of the stage, and the stage sits between
 * the two bars. Equal bars put the middle of the stage at the middle of the
 * screen, which is where a person expects a photograph to be.
 */
export const VIEWER_BAR_HEIGHT = 56;

/**
 * The box the viewer gives the photograph, in layout points.
 *
 * One computation, read by both the style sheet and {@link viewerTarget}, which
 * is the whole point of it being a function: the layout and the request have to
 * agree about how much room the photograph gets.
 *
 * In portrait the insets are the system's — the status bar, the gesture bar, a
 * cutout — and come from `useSafeAreaInsets()`; the two bars are this app's own
 * and {@link VIEWER_BAR_HEIGHT} decides them. In landscape the viewer hides the
 * system bars and its own, and the photograph gets the whole window.
 *
 * A rotation changes the window and therefore this, which is the only thing that
 * should resize the stage.
 */
export function viewerStageBox(
  window: Dimensions,
  insets: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number },
  landscape = window.width > window.height,
): Dimensions {
  if (landscape) return { width: window.width, height: window.height };
  return {
    width: Math.max(0, window.width - insets.left - insets.right),
    height: Math.max(0, window.height - insets.top - insets.bottom - 2 * VIEWER_BAR_HEIGHT),
  };
}

/**
 * The pixel long edge the full-screen viewer wants, or null.
 *
 * ## Why the viewer asks at all
 *
 * Until now it asked for nothing and painted whatever the grid had resolved, so
 * opening a photograph full screen showed the tile's rendition scaled up — a 640
 * pixel image across a 1080 pixel screen. That is the single largest visible
 * difference between this app and the web one, and it is not a fetch problem: on
 * a phone the original is usually right here, so what the viewer was showing was
 * a deliberately smaller copy of a file it already held.
 *
 * ## The stage
 *
 * Handed in rather than computed, and that is the change that makes this
 * honest: {@link viewerStageBox} is the one arithmetic, and the style sheet
 * lays the stage out from the same call. The constant that used to stand in for
 * the chrome was a guess the layout never had to agree with.
 *
 * Within that box the photograph is bounded by its own shape —
 * `min(stage.width, stage.height × aspect)`, with the height falling out of the
 * aspect. That is `stageBox` in `photo-viewer.tsx` restated for this screen.
 */
export function viewerTarget(
  stage: Dimensions,
  source: Dimensions | null,
  orientation: number | null,
  devicePixelRatio: number,
): number | null {
  if (stage.height <= 0 || stage.width <= 0) return null;
  const aspect = displayedAspect(source, orientation);
  const width = Math.min(stage.width, stage.height * aspect);
  return snap(
    measuredPhysicalLongEdge({
      source,
      container: { width, height: width / aspect },
      orientation,
      fit: "contain",
      devicePixelRatio,
    }),
  );
}

/**
 * The rung boundary a measured need snaps to.
 *
 * `currentRenditionPolicies()` rather than a policy fetched from a server, and
 * the difference is what this node is. The web app is handed its boundaries by
 * the data server, because there the ladder is the *server's* to respecify and a
 * browser that guessed would ask for a size the server would not serve. This
 * node holds the ladder in its own bundle and derives against it, so generating
 * the policy locally is reading the same source of truth the resolution uses one
 * call later.
 */
function snap(requiredLongEdge: number | null): number | null {
  return canonicalMeasuredTarget(currentRenditionPolicies().still, requiredLongEdge);
}
