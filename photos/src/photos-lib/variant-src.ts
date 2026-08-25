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

import type { RenditionChoice, RenditionState } from "./rendition-resolution";
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
 * What a still tile or viewer should paint right now, and what it is waiting
 * for.
 *
 * This is the reader for the ideal-and-fallback shape, and the reason it exists
 * separately from {@link variantSrc} is that the two answer different
 * questions. `variantSrc` says "here is the best fit"; this says "here is what
 * to show, here is whether something better is coming, and here is whether
 * anything ever will".
 *
 * `source` is null only when nothing at all has been derived — the signal to
 * paint the inline placeholder.
 */
export interface StillDisplay {
  readonly source: DisplaySource | null;
  /**
   * True while what is on screen is a stand-in for a rung that is still being
   * derived. False both when the ideal is in hand and when it is unreachable,
   * because those are both final.
   */
  readonly awaitingBetter: boolean;
  /**
   * Why the ideal is not here, when it is not. `undecodable-here` is the one
   * the user should be told about: it is temporary and self-healing, which is
   * the opposite of what an indefinitely grey tile communicates.
   */
  readonly state: RenditionState | null;
  /** Pixel size of the rung being waited on, for a derivation request. */
  readonly idealLongEdge: number | null;
}

export function stillDisplay(image: AppImage, targetLongEdge: number): StillDisplay {
  const choice = choiceFor(image, targetLongEdge);
  if (!choice) {
    // No resolution for this target — an older server, a video, or a size the
    // list did not ask for. Fall back to best-fit over whatever is here, which
    // is what every consumer did before this shape existed.
    return {
      source: variantSrc(image, targetLongEdge),
      awaitingBetter: false,
      state: null,
      idealLongEdge: null,
    };
  }

  if (choice.ideal.available) {
    return {
      source: entryToSource(choice.ideal, targetLongEdge),
      awaitingBetter: false,
      state: null,
      idealLongEdge: choice.ideal.longEdge,
    };
  }

  const state = choice.ideal.state ?? "pending";
  return {
    source: choice.fallback ? entryToSource(choice.fallback, targetLongEdge) : null,
    // Keyed on availability, never on "smaller than I asked for". A 300 px
    // original asked for 2048 resolves to a rung that is genuinely below target
    // and genuinely final, so a watcher on the size comparison would wait
    // forever for a rung nobody is going to derive.
    awaitingBetter: state === "pending",
    state,
    idealLongEdge: choice.ideal.longEdge,
  };
}

/**
 * The resolution that answers this request.
 *
 * Exact when the list asked for this size; otherwise the smallest resolved
 * target at or above it, and the largest resolved target when nothing reaches
 * it. Round-up for the same reason the ladder rounds up — the alternative hands
 * a large display a small file — and it means a caller measuring its own
 * viewport gets a defined answer from a list that asked for two fixed sizes.
 */
function choiceFor(image: AppImage, targetLongEdge: number): RenditionChoice | undefined {
  const resolved = image.renditions;
  if (!resolved) return undefined;
  const exact = resolved[String(targetLongEdge)];
  if (exact) return exact;
  const keys = Object.keys(resolved)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (keys.length === 0) return undefined;
  const atLeast = keys.find((k) => k >= targetLongEdge);
  return resolved[String(atLeast ?? keys[keys.length - 1])];
}

function entryToSource(
  entry: RenditionChoice["ideal"],
  targetLongEdge: number,
): DisplaySource | null {
  if (!entry.url || !entry.width || !entry.height) return null;
  return {
    url: entry.url,
    width: entry.width,
    height: entry.height,
    isBelowTarget: entry.longEdge < targetLongEdge,
  };
}

/** Whether a record is a video, from its own type. */
export function isVideoRecord(image: Pick<AppImage, "mimeType">): boolean {
  return image.mimeType.startsWith("video/");
}

/**
 * The best *still* rendition — what a grid tile paints, for a photo or a clip.
 *
 * Necessary because a video's children include a poster and a transcode at the
 * same long edge (`video-poster-720p` and `video-720p` are both 1280), and
 * resolution by size alone breaks the tie on id. Painting a tile from whatever
 * came back would eventually put an MP4 in an `<img>`.
 *
 * Variants with no declared type are treated as stills. That keeps a
 * still-only library working against a server that does not send the type, and
 * it is the safe direction: the alternative — assuming video — would blank the
 * grid for everyone.
 */
export function posterSrc(image: AppImage, targetLongEdge: number): DisplaySource | null {
  const resolved = videoChoice(image, targetLongEdge)?.poster;
  if (resolved) return videoEntryToSource(resolved, targetLongEdge);
  return variantSrc(filterVariants(image, (t) => !t.startsWith("video/")), targetLongEdge);
}

/**
 * The best playable rendition, or `null` when there is none yet.
 *
 * `null` is a real answer and means "show the poster and do not offer play" —
 * a clip whose transcode has not been derived is not broken, it is not ready.
 * Falling back to the original here would be worse than useless: it is the
 * 4 GB file the transcode exists to avoid streaming, and on a phone it is the
 * one thing guaranteed not to play.
 */
export function playbackSrc(image: AppImage, targetLongEdge: number): DisplaySource | null {
  const resolved = videoChoice(image, targetLongEdge)?.playback;
  if (resolved) return videoEntryToSource(resolved, targetLongEdge);
  return variantSrc(filterVariants(image, (t) => t.startsWith("video/")), targetLongEdge);
}

function videoChoice(image: AppImage, target: number) {
  const choices = image.videoRenditions;
  if (!choices) return undefined;
  if (choices[String(target)]) return choices[String(target)];
  const keys = Object.keys(choices).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const key = keys.find((value) => value >= target) ?? keys[keys.length - 1];
  return key === undefined ? undefined : choices[String(key)];
}

function videoEntryToSource(
  entry: { url: string; width: number; height: number },
  target: number,
): DisplaySource {
  return {
    url: entry.url,
    width: entry.width,
    height: entry.height,
    isBelowTarget: Math.max(entry.width, entry.height) < target,
  };
}

function filterVariants(image: AppImage, keep: (type: string) => boolean): AppImage {
  return {
    ...image,
    variants: Object.fromEntries(
      Object.entries(image.variants).filter(([, v]) => keep(v.type ?? "image/")),
    ),
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
