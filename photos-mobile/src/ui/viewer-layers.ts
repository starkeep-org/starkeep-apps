/**
 * The rules of the viewer's layer stack, apart from the component that draws it.
 *
 * A viewer page draws each rung of its photograph in an `<Image>` of its own,
 * oldest at the bottom, and never re-points a mounted one. `StillStage` in
 * `LibraryViewer.tsx` explains why: re-pointing an `expo-image` view reloads it,
 * and a reload of a picture already on screen is a visible blackout.
 *
 * These are the decisions that keep the stack correct — which layer a new URI
 * mounts, which ones a display collapses, and which one carries the ThumbHash —
 * kept here so they are decidable in Node. Every function returns its input
 * unchanged when nothing changes, so a React state update can bail out.
 */

/**
 * The stack after the stage's URI changes to `uri`.
 *
 * - A new URI is appended. The layer beneath is the previous picture, which is
 *   a better thing to have under a decode than a blur.
 * - The URI already on top changes nothing.
 * - A URI further down is a page going back to a picture it showed earlier,
 *   which happens when a resolution is replaced by an older one. The stack drops
 *   back to that layer rather than mounting a second `<Image>` under the same
 *   key, which React would treat as one element.
 */
export function nextLayers(current: readonly string[], uri: string): readonly string[] {
  const at = current.indexOf(uri);
  // Guarded on `at >= 0`: on an empty stack, a missing URI's -1 equals the top
  // index's -1, and a stage that mounted with nothing to draw stayed on its
  // ThumbHash when its first picture arrived.
  if (at < 0) return [...current, uri];
  return at === current.length - 1 ? current : current.slice(0, at + 1);
}

/**
 * The stack after `layer` has rendered: that layer alone, if it is still the
 * top one.
 *
 * A display callback from a layer that has since been superseded must not throw
 * away the newer layer above it, so it changes nothing.
 */
export function collapseLayers(current: readonly string[], displayed: string): readonly string[] {
  return current[current.length - 1] === displayed && current.length > 1 ? [displayed] : current;
}

/**
 * The layer that carries the ThumbHash: the first one the stage mounted, for as
 * long as the stage lives.
 *
 * Fixed rather than handed on, because `expo-image` on Android reloads a view
 * whose placeholder changes exactly as it reloads one whose source changes. A
 * stage that mounted with nothing to draw gives the ThumbHash to the first
 * layer that arrives.
 */
export function thumbHashLayer(fixed: string | null, uri: string): string {
  return fixed ?? uri;
}
