/**
 * The grid's selection, as a pure function of clicks.
 *
 * A selection is a set of ids plus the anchor a shift-click extends from. On a
 * desktop, a tile's hover checkbox starts it and a shift-click selects the run
 * between the anchor and the clicked tile. On a phone, a long press starts it.
 * While a selection is active, a click or tap on a tile toggles that tile
 * rather than opening it. Clearing the last id ends the selection.
 */

export interface Selection {
  readonly ids: ReadonlySet<string>;
  /** The tile a shift-click extends from: the last one toggled. */
  readonly anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null };

export function isSelecting(selection: Selection): boolean {
  return selection.ids.size > 0;
}

/** Toggle one tile, and make it the anchor. */
export function toggle(selection: Selection, id: string): Selection {
  const ids = new Set(selection.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return ids.size === 0 ? EMPTY_SELECTION : { ids, anchor: id };
}

/**
 * Select every tile from the anchor to `id`, in the order the grid shows
 * them, keeping what was already selected. With no anchor still shown, it
 * toggles `id` alone.
 */
export function extendTo(selection: Selection, id: string, order: readonly string[]): Selection {
  const from = selection.anchor === null ? -1 : order.indexOf(selection.anchor);
  const to = order.indexOf(id);
  if (from < 0 || to < 0) return toggle(selection, id);
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const ids = new Set(selection.ids);
  for (const each of order.slice(lo, hi + 1)) ids.add(each);
  return { ids, anchor: id };
}

/** Drop ids no longer shown, as when a photo is deleted or an album view changes. */
export function retainShown(selection: Selection, shown: ReadonlySet<string>): Selection {
  if ([...selection.ids].every((id) => shown.has(id))) return selection;
  const ids = new Set([...selection.ids].filter((id) => shown.has(id)));
  if (ids.size === 0) return EMPTY_SELECTION;
  return { ids, anchor: selection.anchor !== null && ids.has(selection.anchor) ? selection.anchor : null };
}
