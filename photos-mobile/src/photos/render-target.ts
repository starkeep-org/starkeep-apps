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
 * ## Why the fit is `contain`, on both surfaces
 *
 * Because neither surface crops. The viewer never did. The grid stopped when it
 * became justified rows: a row scales its photographs to a common height and
 * gives each one a box of its own shape, so a photograph fits its box exactly
 * and `cover` and `contain` measure the same number. Asking for `contain`
 * anyway is what keeps that true if a box ever stops matching its photograph —
 * `cover` would then silently request the pixels of the crop that is not shown.
 *
 * The web app's grid passes `cover` for historical reasons and gets the same
 * answer for the same reason. See `justified-layout.ts`.
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
  justifiedRows,
  measuredPhysicalLongEdge,
  type Dimensions,
  type JustifiedRow,
} from "@starkeep/photos-ladder";

export type { JustifiedRow };

export type { Dimensions };

/**
 * The width-over-height ratio a photograph is shown at, guessing when nothing
 * knows.
 *
 * Re-exported under this name so the library page can lay a grid out without
 * importing the ladder package itself, which `__tests__/ladder-boundary.test.ts`
 * forbids outside this directory. The rule is `@starkeep/photos-ladder`'s and is
 * shared with the web app's grid on purpose: two surfaces that disagreed about a
 * photograph's shape would give it differently sized boxes and therefore request
 * different rungs for the same picture.
 *
 * It is not ladder vocabulary — no class name crosses this line, only a ratio —
 * which is why re-exporting it is not a hole in that boundary.
 */
export const displayedAspectOf = displayedAspect;

/**
 * The grid's geometry, in layout points, plus the display density.
 *
 * Points and not pixels, because that is what React Native's `Dimensions` and
 * the style sheet both work in. The conversion happens once, inside
 * `measuredPhysicalLongEdge`, which is the only place that should know the
 * difference.
 */
export interface GridGeometry {
  /** The height a justified row aims for. */
  readonly targetRowHeight: number;
  /** The width the rows fill — the window less the content padding. */
  readonly containerWidth: number;
  readonly devicePixelRatio: number;
}

/**
 * The box a justified row assigns this photograph, in layout points.
 *
 * ## Why the box is derived rather than read back off the layout
 *
 * The plan this implements described `tileTarget` as taking "the box the
 * justified layout assigned", which would mean laying the page out before
 * anything could be resolved or fetched. Deriving it instead is both simpler and
 * more stable, and the stability is the real argument.
 *
 * A row's final height is its target height times a fill scale, and the fill
 * scale depends on which *other* photographs share the row. So the same
 * photograph moves rows — and changes height — when a page is appended, when the
 * device rotates, or when a record ahead of it is deleted. A request measured
 * from the final height would change with it, and the phone would fetch a second
 * rung for a picture it already had, for a difference nothing can see. Measured
 * from the target height, a photograph asks for the same rung for as long as it
 * is that shape on that screen.
 *
 * The two differ by the fill scale, which the layout keeps small on purpose —
 * and `canonicalTarget` snaps to a rung, which absorbs what is left.
 *
 * ## Why the container width is a cap and not a suggestion
 *
 * A panorama is the case that makes it necessary. At a target row height of 160
 * points a 10:1 photograph would want 1600 points of width, which is four times
 * a phone's screen; measured that way it would ask for the top of the ladder for
 * a picture the layout is about to draw 39 points tall. What the layout actually
 * does is give it the whole row and let its height fall out of its shape, and
 * capping the width here is the same rule stated once.
 */
export function tileBox(
  source: Dimensions | null,
  orientation: number | null,
  grid: GridGeometry,
): Dimensions {
  const aspect = displayedAspect(source, orientation);
  const width = Math.min(aspect * grid.targetRowHeight, grid.containerWidth);
  return { width, height: width / aspect };
}

/**
 * The pixel long edge one grid tile wants, or null when the box is unusable.
 *
 * Null rather than a guess for a container that has not been measured — a zero
 * width is a screen that has not laid out yet, and resolving against it would
 * pin every record on the page to the bottom rung.
 */
export function tileTarget(
  box: Dimensions,
  source: Dimensions | null,
  orientation: number | null,
  devicePixelRatio: number,
): number | null {
  return snap(
    measuredPhysicalLongEdge({
      source,
      container: box,
      orientation,
      fit: "contain",
      devicePixelRatio,
    }),
  );
}

/**
 * The pixel long edge one grid tile wants, from the grid's geometry alone.
 *
 * The composition the library page actually calls: {@link tileBox} then
 * {@link tileTarget}. The two stay separate because the box is worth naming —
 * it is the thing the layout and the request have to agree about.
 */
export function gridTileTarget(
  source: Dimensions | null,
  orientation: number | null,
  grid: GridGeometry,
): number | null {
  return tileTarget(tileBox(source, orientation, grid), source, orientation, grid.devicePixelRatio);
}

/**
 * Vertical room the viewer's chrome takes out of the screen, in layout points.
 *
 * The phone's counterpart to `photo-viewer.tsx`'s `CHROME_ALLOWANCE_PX`, and a
 * different number for a different chrome: this viewer draws a caption block and
 * a row of controls under the photograph rather than a browser's toolbar over
 * it. Wrong here is wrong twice — the photograph is laid out too large and sized
 * too large — which is why correcting the constant is the fix rather than
 * measuring around it.
 */
export const VIEWER_CHROME_ALLOWANCE = 160;

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
 * The screen less {@link VIEWER_CHROME_ALLOWANCE}, then bounded by the
 * photograph's own shape — `min(availableWidth, availableHeight × aspect)`, with
 * the height falling out of the aspect. That is `stageBox` in `photo-viewer.tsx`
 * restated for this screen, and it has to match what the viewer's style sheet
 * does, or the layout and the request disagree about how much room the photo
 * gets.
 */
export function viewerTarget(
  screen: Dimensions,
  source: Dimensions | null,
  orientation: number | null,
  devicePixelRatio: number,
): number | null {
  const availableHeight = screen.height - VIEWER_CHROME_ALLOWANCE;
  if (availableHeight <= 0 || screen.width <= 0) return null;
  const aspect = displayedAspect(source, orientation);
  const width = Math.min(screen.width, availableHeight * aspect);
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

/**
 * Lay a page of items out into justified rows.
 *
 * Re-exported through this directory for the same reason
 * {@link displayedAspectOf} is: `__tests__/ladder-boundary.test.ts` keeps
 * `@starkeep/photos-ladder` out of the UI files, and a grid component is a UI
 * file. What crosses this line is a list of boxes.
 *
 * The layout itself is the web app's, verbatim, from the shared package. A
 * second implementation would disagree about which box a photograph gets, and
 * the box is what {@link tileTarget} measures the rendition request from — so
 * two layouts would mean two different rungs fetched for the same picture on
 * two devices.
 */
export function layOutRows<T>(
  items: readonly T[],
  aspectOf: (item: T) => number,
  options: { readonly containerWidth: number; readonly targetRowHeight: number; readonly gap: number },
): Array<JustifiedRow<T>> {
  return justifiedRows(items, aspectOf, options);
}
