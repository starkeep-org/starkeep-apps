/**
 * Choosing which resolved rendition to display.
 *
 * Consumers of this module ask for a **target long edge in pixels** and get a
 * URL. They never name a size class and never learn that a ladder exists —
 * which is the point, because class maxima move when the visual test lands and
 * can move again on a respec, and a client that hard-codes a class name is a
 * client that has to be found and changed on each of those events, on devices
 * that update on their own schedule.
 *
 * The *server* did the resolution. This is only the lookup of what was asked
 * for, plus a defined answer for the case where the caller asks for a size it
 * did not request.
 */

import type { AppImage } from "./types/app-image";

export interface DisplaySource {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  /**
   * True when what came back is smaller than what was asked for — the record's
   * ladder does not go that high. Callers can use it to decide whether a
   * further, larger request is worth issuing; nothing is broken.
   */
  readonly isBelowTarget: boolean;
}

/**
 * The best available rendition for a target long edge.
 *
 * Prefers the exact target the caller requested, since that is what the server
 * resolved. Falls back to the smallest requested target at or above it, then to
 * the largest available — the same shape of rule the server applies, so a
 * client that asked for two sizes and wants a third gets a sensible answer
 * rather than nothing.
 *
 * `null` when the record has no renditions at all, which is the signal to show
 * the inline placeholder.
 */
export function variantSrc(image: AppImage, targetLongEdge: number): DisplaySource | null {
  const entries = Object.entries(image.variants);
  if (entries.length === 0) return null;

  const exact = image.variants[String(targetLongEdge)];
  if (exact) {
    return {
      url: exact.url,
      width: exact.width,
      height: exact.height,
      isBelowTarget: Math.max(exact.width, exact.height) < targetLongEdge,
    };
  }

  const byLongEdge = entries
    .map(([, v]) => v)
    .sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
  const atLeast = byLongEdge.find((v) => Math.max(v.width, v.height) >= targetLongEdge);
  const chosen = atLeast ?? byLongEdge[byLongEdge.length - 1]!;
  return {
    url: chosen.url,
    width: chosen.width,
    height: chosen.height,
    isBelowTarget: Math.max(chosen.width, chosen.height) < targetLongEdge,
  };
}

/**
 * The sizes a grid tile asks for.
 *
 * Tile size multiplied by the device pixel ratio, because a 180 px tile on a
 * 3× phone is a 540 px image and asking for 180 would show a blurry one.
 * Capped, because a hypothetical 4× display should not silently pull the
 * largest rendition for a thumbnail — and under Intelligent-Tiering a read
 * promotes an object back to Frequent Access for 30 days, so speculatively
 * touching large objects quietly undoes the tiering that makes them cheap.
 */
export function tileTargetLongEdge(tileCssPx: number, devicePixelRatio: number): number {
  return Math.min(Math.round(tileCssPx * Math.max(1, devicePixelRatio)), 1024);
}

/**
 * The size a fullscreen viewer asks for.
 *
 * The actual viewport long edge, again scaled by pixel ratio. Deliberately not
 * rounded up to "the next class" — there are no classes here, and rounding up
 * is the server's job when it resolves.
 */
export function viewportTargetLongEdge(
  viewportWidth: number,
  viewportHeight: number,
  devicePixelRatio: number,
): number {
  return Math.round(Math.max(viewportWidth, viewportHeight) * Math.max(1, devicePixelRatio));
}
