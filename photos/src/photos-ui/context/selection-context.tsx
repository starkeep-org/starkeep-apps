import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  EMPTY_SELECTION,
  extendTo,
  isSelecting,
  toggle,
  type Selection,
} from "@/photos-lib/selection";

/**
 * The grid's selection, for every tile under the provider.
 *
 * A context rather than props because the tiles sit three components below
 * the grid (grid → date section → rows → tile), and only the tile and the
 * selection bar care. A tile outside any provider — an album cover, a test —
 * offers no checkbox and opens on click as it always did.
 */
export interface SelectionControls {
  readonly selection: Selection;
  readonly selecting: boolean;
  isSelected(id: string): boolean;
  /** The checkbox, or a click on a tile while selecting. Shift extends a run. */
  choose(id: string, extend: boolean): void;
  /** A long press: starts a selection with this tile, or adds it to one. */
  pressAndHold(id: string): void;
  clear(): void;
  /** Replace the selection, as when the shown photos change. */
  set(selection: Selection): void;
}

const SelectionContext = createContext<SelectionControls | null>(null);

export function SelectionProvider({
  order,
  children,
}: {
  /** The ids in the order the grid shows them, for shift-click runs. */
  order: readonly string[];
  children: React.ReactNode;
}) {
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const choose = useCallback(
    (id: string, extend: boolean) =>
      setSelection((s) => (extend && isSelecting(s) ? extendTo(s, id, order) : toggle(s, id))),
    [order],
  );
  const pressAndHold = useCallback(
    (id: string) => setSelection((s) => (s.ids.has(id) ? s : toggle(s, id))),
    [],
  );
  const clear = useCallback(() => setSelection(EMPTY_SELECTION), []);
  const value = useMemo<SelectionControls>(
    () => ({
      selection,
      selecting: isSelecting(selection),
      isSelected: (id) => selection.ids.has(id),
      choose,
      pressAndHold,
      clear,
      set: setSelection,
    }),
    [selection, choose, pressAndHold, clear],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

/** The selection, or null for a tile no selection applies to. */
export function useSelection(): SelectionControls | null {
  return useContext(SelectionContext);
}

/** Opts a subtree out of an enclosing selection, as album covers do. */
export function NoSelection({ children }: { children: React.ReactNode }) {
  return <SelectionContext.Provider value={null}>{children}</SelectionContext.Provider>;
}
