/**
 * The open photo, kept in the URL.
 *
 * The viewer used to be React state alone, so Back left the app instead of
 * closing it, and an open photo could be neither linked nor reloaded. The URL is
 * now the one place the open photo lives: `/photo/<id>` shows it over the grid,
 * and `/` shows the grid alone. A hook rather than a router, for the reason
 * `src/client-routes.ts` gives.
 *
 * Three moves, and each one writes history differently:
 *
 *   - Opening a photo from the grid pushes an entry, so Back closes the viewer.
 *   - Stepping to the previous or next photo replaces the entry. Back closes the
 *     viewer in one step rather than walking through every photo seen (decision 6
 *     in `~/projects/starkeep/triage-managed-login-followups-2026-10-28.md`).
 *   - Closing goes back when this page pushed the entry, so the closed photo sits
 *     ahead in history for Forward rather than behind for Back. A photo reached
 *     by a link has no grid behind it in history, so closing one replaces the
 *     entry with `/` instead of leaving the app.
 */

import { useCallback, useEffect, useState } from "react";
import { PHOTO_ROUTE_PREFIX } from "../client-routes";
import { BASE_PATH, appRelativePath, withBasePath } from "./base-path";

/** `history.state` on an entry this page pushed by opening a photo. */
const PUSHED = { photosViewer: "pushed" } as const;

const APP_HOME = BASE_PATH || "/";

export function photoPath(id: string): string {
  return withBasePath(PHOTO_ROUTE_PREFIX + encodeURIComponent(id));
}

/** The photo a pathname names, or null for any path that is not `/photo/<id>`. */
export function photoIdFromPath(pathname: string): string | null {
  const path = appRelativePath(pathname);
  if (!path.startsWith(PHOTO_ROUTE_PREFIX)) return null;
  const segment = path.slice(PHOTO_ROUTE_PREFIX.length);
  if (!segment || segment.includes("/")) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function pushedHere(): boolean {
  const state = window.history.state as { photosViewer?: unknown } | null;
  return state?.photosViewer === PUSHED.photosViewer;
}

export interface PhotoRoute {
  photoId: string | null;
  open: (id: string) => void;
  step: (id: string) => void;
  close: () => void;
}

export function usePhotoRoute(): PhotoRoute {
  const [photoId, setPhotoId] = useState(() => photoIdFromPath(window.location.pathname));

  useEffect(() => {
    const onPopState = () => setPhotoId(photoIdFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const open = useCallback((id: string) => {
    window.history.pushState(PUSHED, "", photoPath(id));
    setPhotoId(id);
  }, []);

  const step = useCallback((id: string) => {
    // The entry's state carries over, so a photo stepped to from one opened in
    // the grid still closes with Back.
    window.history.replaceState(window.history.state, "", photoPath(id));
    setPhotoId(id);
  }, []);

  const close = useCallback(() => {
    if (pushedHere()) window.history.back();
    else window.history.replaceState(null, "", APP_HOME);
    // Set now rather than on the `popstate` that `back()` fires later, so a
    // caller that closes from an effect does not close twice before it lands.
    setPhotoId(null);
  }, []);

  return { photoId, open, step, close };
}
