/**
 * The order a photo library is read in, stated once for both sides of it.
 *
 * `/data/records?order=captured_at.desc,created_at.desc` cuts every page of the
 * library in this order, and the grid displays what arrives. The two have to
 * agree on one key, because a page is a *prefix* of the library rather than the
 * whole of it: a client that ordered by a different key than the server paged
 * by would show a page ordered one way and continued another, which is the
 * failure that made the old grid group whatever happened to arrive.
 *
 * ## Why capture time, then import time, and never a coalesce of the two
 *
 * `captured_at` is the only ordering key `/data/records` answers that is not a
 * column of the records table — it lives in the per-category metadata table and
 * the compiler reaches it through a `coalesce()` over the image and video
 * joins. `created_at` is the serialized HLC beside it, and the platform
 * deliberately refuses to coalesce the two: an ISO-8601 string sorts above every
 * HLC string for lexical reasons that have nothing to do with time, so the
 * merged key would order the library by *whether* a capture time is known.
 * Naming import time as a second key instead gives the no-capture records a
 * trailing block ordered among themselves, which is honest about what is known.
 *
 * ## The one key the server cannot apply
 *
 * `dateTakenOverride` lives in Photos' own app-syncable table. The platform's
 * records query cannot join it and should not learn how, but a photo whose date
 * somebody corrected has to move. So the override replaces the capture time
 * here — and only here, which is why this comparator is not simply "preserve
 * what arrived".
 */

import type { AppImage } from "./types/app-image";

/**
 * The capture instant this image sorts and groups by, or null when none is
 * known.
 *
 * Deliberately **not** `effectiveDateTaken`, which falls back to the import
 * time so that a tile always has a date to show. A fallback is the right answer
 * for a caption and the wrong one for an ordering key: it would place a record
 * whose capture time is unknown among the records whose capture time is known,
 * where the server puts it last.
 */
export function captureKey(image: AppImage): string | null {
  return image.dateTakenOverride ?? image.exif.capturedAt ?? null;
}

/**
 * Newest capture first, nulls last, then newest import first, then id.
 *
 * An exact mirror of `order=captured_at.desc,created_at.desc` plus the `id asc`
 * tiebreaker the query parser appends to every ordering. Lexical comparison is
 * chronological for both keys: `captured_at` is canonical ISO-8601 in UTC, and
 * `created_at` arrives from the route as an ISO instant.
 */
export function compareCaptureOrder(a: AppImage, b: AppImage): number {
  const left = captureKey(a);
  const right = captureKey(b);
  if (left !== right) {
    // Nulls last, whichever direction the key runs — the convention
    // `/data/records` fixes on every ordering key so that one cursor means the
    // same thing against a local and a cloud data server.
    if (left === null) return 1;
    if (right === null) return -1;
    return left < right ? 1 : -1;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The `order` parameter this comparator mirrors.
 *
 * Exported so the route that sends it and the comparator that matches it cannot
 * drift apart silently — a test pins the pair.
 */
export const LIBRARY_ORDER = "captured_at.desc,created_at.desc";
