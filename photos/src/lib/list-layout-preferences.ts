import { useCallback, useEffect, useState } from "react";
import { useNarrowViewport } from "./use-narrow-viewport";

/**
 * How the photo list is laid out, as the viewer last left it.
 *
 * These are display preferences for one person on one machine, not library
 * state, so they live in localStorage and never travel with the photos. A
 * browser that refuses storage simply gets the defaults every time, which is a
 * slightly forgetful list rather than a broken one.
 */
export interface ListLayoutPreferences {
  rowHeight: number;
  groupByDate: boolean;
}

export const ROW_HEIGHT_MIN = 100;
export const ROW_HEIGHT_MAX = 480;
export const ROW_HEIGHT_STEP = 10;

/**
 * Default row heights, which differ by device because the same row height means
 * different things on the two: 320 px is a comfortable band on a desktop and
 * most of a phone screen. A viewer who moves the slider overrides both, and the
 * override then applies at every width — an explicit choice outranks a guess
 * made from the viewport.
 */
export const DESKTOP_DEFAULT_ROW_HEIGHT = 320;
export const MOBILE_DEFAULT_ROW_HEIGHT = 180;

const STORAGE_KEY = "starkeep:photos:listLayout";

/**
 * What is actually persisted. `rowHeight` is null while the viewer has never
 * chosen one, which is what keeps the default responsive to the viewport
 * instead of freezing whichever width the app first opened at.
 */
interface StoredPreferences {
  rowHeight: number | null;
  groupByDate: boolean;
}

const UNSET: StoredPreferences = { rowHeight: null, groupByDate: false };

function clampRowHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(ROW_HEIGHT_MAX, Math.max(ROW_HEIGHT_MIN, Math.round(value)));
}

function read(): StoredPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return UNSET;
    const parsed = JSON.parse(raw) as Partial<StoredPreferences>;
    return {
      rowHeight: clampRowHeight(parsed.rowHeight),
      groupByDate: parsed.groupByDate === true,
    };
  } catch {
    return UNSET;
  }
}

export function useListLayoutPreferences(): [
  ListLayoutPreferences,
  (patch: Partial<ListLayoutPreferences>) => void,
] {
  const [stored, setStored] = useState<StoredPreferences>(UNSET);
  const narrow = useNarrowViewport();

  // Read after mount rather than in the initial state, so a server-rendered or
  // pre-hydration pass and the browser agree on the first markup.
  useEffect(() => setStored(read()), []);

  const update = useCallback((patch: Partial<ListLayoutPreferences>) => {
    setStored((previous) => {
      const next: StoredPreferences = {
        rowHeight: patch.rowHeight === undefined ? previous.rowHeight : clampRowHeight(patch.rowHeight),
        groupByDate: patch.groupByDate ?? previous.groupByDate,
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // A viewer with storage disabled still gets the change for this
        // session; only remembering it is lost.
      }
      return next;
    });
  }, []);

  const rowHeight =
    stored.rowHeight ?? (narrow ? MOBILE_DEFAULT_ROW_HEIGHT : DESKTOP_DEFAULT_ROW_HEIGHT);

  return [{ rowHeight, groupByDate: stored.groupByDate }, update];
}
