/**
 * The rules of the viewer's layer stack, apart from the component that draws it.
 *
 * A viewer page draws its photograph as a stack of `<Image>` layers, one per
 * rung, oldest at the bottom. A mounted layer is never re-pointed. `StillStage`
 * in `LibraryViewer.tsx` explains why: re-pointing an `expo-image` view reloads
 * it, and a reload of a picture already on screen is a visible blackout.
 *
 * **One rule holds the stack together: a picture on screen stays mounted and
 * opaque until a newer layer has drawn above it.** A layer over another is
 * transparent until its own `onDisplay`, so nothing undrawn ever covers
 * anything, and a layer leaves only from beneath a layer that has drawn.
 *
 * These are the decisions that keep that rule, kept here so they are decidable
 * in Node. Every function returns its input unchanged when nothing changes, so a
 * React state update can bail out.
 */

export interface LayerStack {
  /** The mounted layers' URIs, bottom first. */
  readonly layers: readonly string[];
  /** The layers that have drawn: the bottom layer, and these, may be opaque. */
  readonly displayed: ReadonlySet<string>;
}

/** The stack a stage mounts with: the rung that is here, if any. */
export function initialStack(uri: string | null): LayerStack {
  return { layers: uri ? [uri] : [], displayed: new Set() };
}

/**
 * The stack after the stage's URI changes to `uri`.
 *
 * - A new URI is appended above the layers that have drawn, transparent until
 *   it draws. A layer beneath that has not drawn yet leaves: it has shown
 *   nothing, so nothing is lost, and keeping it would put two pictures on screen
 *   in quick succession. On every open on a Pixel 10a the stage's rung was known
 *   before the tile's rung had drawn, and the tile's rung then showed for one or
 *   two frames before the sharper one replaced it.
 * - The URI already on top changes nothing.
 * - A URI further down is a page going back to a picture it holds already,
 *   which happens when a resolution is replaced by an older one. The stack drops
 *   the layers above that one rather than mounting a second `<Image>` under the
 *   same key, which React would treat as one element. Only the bottom layer of a
 *   settled stack has drawn, so every layer dropped here is one still decoding.
 */
export function withUri(stack: LayerStack, uri: string): LayerStack {
  const at = stack.layers.indexOf(uri);
  if (at < 0) {
    return keep(stack, [...stack.layers.filter((layer) => stack.displayed.has(layer)), uri]);
  }
  if (at === stack.layers.length - 1) return stack;
  return keep(stack, stack.layers.slice(0, at + 1));
}

/**
 * The first half of a layer drawing: it turns opaque. Everything beneath stays
 * mounted until {@link collapseBelow}, a frame later.
 *
 * A display from a layer no longer in the stack changes nothing.
 */
export function markDisplayed(stack: LayerStack, layer: string): LayerStack {
  if (!stack.layers.includes(layer) || stack.displayed.has(layer)) return stack;
  return { ...stack, displayed: new Set([...stack.displayed, layer]) };
}

/**
 * The second half: every layer beneath a drawn layer leaves.
 *
 * Layers above it stay, because they are still decoding and will cover it when
 * they draw. That is also what makes a late display harmless: a layer that
 * draws after a newer one above it has already drawn has left the stack, and
 * this changes nothing.
 */
export function collapseBelow(stack: LayerStack, layer: string): LayerStack {
  const at = stack.layers.indexOf(layer);
  if (at <= 0 || !stack.displayed.has(layer)) return stack;
  return keep(stack, stack.layers.slice(at));
}

/**
 * A layer that will not decode leaves, and the layers beneath it stay.
 *
 * Collapsing onto a failed layer instead would throw away the picture under it
 * and leave an empty view on top.
 */
export function dropLayer(stack: LayerStack, layer: string): LayerStack {
  if (!stack.layers.includes(layer)) return stack;
  return keep(
    stack,
    stack.layers.filter((candidate) => candidate !== layer),
  );
}

/** The stack reduced to `layers`, forgetting displays of the layers that left. */
function keep(stack: LayerStack, layers: readonly string[]): LayerStack {
  return { layers, displayed: new Set([...stack.displayed].filter((layer) => layers.includes(layer))) };
}
