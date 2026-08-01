/**
 * The rendition ladder: which derived sizes Photos makes from a record, and
 * when.
 *
 * ## Every integer in this file is provisional
 *
 * The long edges and quality levels below are reasoned from panel resolutions
 * and storage cost, **not measured**. They are the input to a visual test whose
 * output replaces them, and that test is a gate on backfilling the library —
 * because a quality level a little too low is invisible on a small sample and
 * irreversible across 60,000 photos once the originals are in deep archive.
 *
 * The *structure* is settled; the numbers are not. Which is why:
 *
 *   - No consumer names a size class. Consumers ask for a target long edge in
 *     pixels and the server resolves which rendition to serve, so changing
 *     these numbers changes nothing outside this file.
 *   - Tests assert relationships (never upscales, forms a contiguous prefix,
 *     each class exceeds the one below) rather than literals. A test asserting
 *     `1280` would have to be edited by the same change that makes it wrong,
 *     which is precisely when nobody is thinking about whether it *should* be.
 *
 * ## Sizes are maxima, not targets
 *
 * A rendition's long edge is `min(original long edge, class maximum)`. A class
 * never upscales and never emits a file larger than its source, so a 900 px
 * original produces a 900 px file in every class above 900. That is why a class
 * name tells you nothing about a file's actual size, and why resolution has to
 * happen server-side against real dimensions.
 */

/**
 * A derived size class.
 *
 * Values are the `photos/rendition` label's vocabulary. They are opaque to the
 * platform — it sees a label key and the width/height columns — and appear here
 * only because Photos is the app that owns the ladder.
 */
export type SizeClass =
  | "image-thumb"
  | "image-medium"
  | "image-screen"
  | "image-large"
  | "video-poster-thumb"
  | "video-poster-720p"
  | "video-skim"
  | "video-720p"
  | "video-1080p"
  | "image-motion"
  | "image-motion-preview";

export interface StillClassSpec {
  readonly sizeClass: SizeClass;
  /** Maximum long edge in pixels. A maximum, never a target. */
  readonly maxLongEdge: number;
  /** Encoder quality, on the codec's own scale. */
  readonly quality: number;
  /** What this rung is for — the reason its number is what it is. */
  readonly serves: string;
}

/**
 * The still ladder, ascending.
 *
 * Order is load-bearing: `applicableStillClasses` relies on it to produce a
 * contiguous prefix, and the derivation sweeper and the archive gate both read
 * "top applicable class" off that.
 */
export const STILL_LADDER: readonly StillClassSpec[] = [
  {
    sizeClass: "image-thumb",
    maxLongEdge: 400,
    quality: 50,
    serves: "grid tiles, list rows",
  },
  {
    sizeClass: "image-medium",
    maxLongEdge: 1280,
    quality: 55,
    // The AI rung. Every routine model input is ≤640 px, so this has 2× headroom
    // and `image-screen` would ship and decode 4× the pixels a model consumes.
    serves: "all routine on-device AI, fullscreen stage 1, share/export default",
  },
  {
    sizeClass: "image-screen",
    maxLongEdge: 2560,
    quality: 55,
    serves: "phone fullscreen, laptop, AI re-crops of small subjects",
  },
  {
    sizeClass: "image-large",
    maxLongEdge: 4272,
    quality: 60,
    serves: "4K TV, laptop retina fullscreen, zoom, OCR, print preview",
  },
];

/**
 * Which still classes apply to an original of this long edge.
 *
 * **Rule 1** — a class's output is `min(original, class maximum)`; it never
 * upscales.
 *
 * **Rule 2** — generate a class when the original exceeds the *next lower
 * class's* maximum. No offset, no margin. The bottom rung is always generated.
 *
 * The consequence the rest of the system depends on: applicable classes are a
 * contiguous prefix from the bottom, so "top applicable class" fully describes
 * the set. Both the ladder-complete gate (which decides when an original may be
 * archived) and the derivation sweeper rely on that, and neither would be
 * expressible if the set could have holes.
 */
export function applicableStillClasses(originalLongEdge: number): StillClassSpec[] {
  const out: StillClassSpec[] = [];
  for (let i = 0; i < STILL_LADDER.length; i++) {
    const spec = STILL_LADDER[i]!;
    // The bottom rung is unconditional, so every record has an instantly
    // readable copy and the grid needs no fallback path.
    if (i === 0) {
      out.push(spec);
      continue;
    }
    const below = STILL_LADDER[i - 1]!;
    if (originalLongEdge > below.maxLongEdge) out.push(spec);
    else break; // Ascending, so nothing above can qualify either.
  }
  return out;
}

/** The long edge a class actually emits for this original. Rule 1. */
export function renditionLongEdge(spec: StillClassSpec, originalLongEdge: number): number {
  return Math.min(originalLongEdge, spec.maxLongEdge);
}

/**
 * The largest class that applies — the whole set, given contiguity.
 *
 * Returns the bottom rung for any positive input, because the bottom rung is
 * unconditional.
 */
export function topApplicableStillClass(originalLongEdge: number): StillClassSpec {
  const applicable = applicableStillClasses(originalLongEdge);
  return applicable[applicable.length - 1]!;
}

/**
 * True when the original is functionally the top of its own ladder — its long
 * edge is at or below the bottom rung's maximum, so every class it generates is
 * a copy of it at the same size.
 *
 * One of the two floors on archiving: freezing such an original saves nothing,
 * because the thing that would be read instead is the same size.
 */
export function isOwnTopOfLadder(originalLongEdge: number): boolean {
  return originalLongEdge <= STILL_LADDER[0]!.maxLongEdge;
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

export interface VideoClassSpec {
  readonly sizeClass: SizeClass;
  readonly maxLongEdge: number;
  /**
   * Bitrate ceiling in bits per second, for transcoded classes.
   *
   * Video has a **second maximum**: `min(source, class max)` applies on
   * resolution and bitrate independently. A 480p clip at 800 kbps is already
   * below both of `video-720p`'s ceilings.
   */
  readonly maxBitrate?: number;
  /** Poster and skim classes are stills / derived sequences, not transcodes. */
  readonly kind: "poster" | "skim" | "transcode";
  /** Off unless the library enables it — see DEFAULT_DISABLED_CLASSES. */
  readonly optional?: boolean;
  readonly serves: string;
}

export const VIDEO_LADDER: readonly VideoClassSpec[] = [
  {
    sizeClass: "video-poster-thumb",
    maxLongEdge: 400,
    kind: "poster",
    serves: "grid tile",
  },
  {
    sizeClass: "video-poster-720p",
    // Pinned to video-720p's maximum rather than chosen independently: a poster
    // sharper than the footage it hands off to degrades visibly at the moment
    // playback starts.
    maxLongEdge: 1280,
    kind: "poster",
    serves: "larger-thumbnail UIs, pre-roll / paused state",
  },
  {
    sizeClass: "video-skim",
    maxLongEdge: 480,
    kind: "skim",
    serves: "hover / long-press identification",
  },
  {
    sizeClass: "video-720p",
    maxLongEdge: 1280,
    maxBitrate: 1_500_000,
    kind: "transcode",
    serves: "inline playback",
  },
  {
    sizeClass: "video-1080p",
    maxLongEdge: 1920,
    maxBitrate: 4_000_000,
    kind: "transcode",
    optional: true,
    serves: "TV / large-screen playback",
  },
];

/** Classes a library does not generate unless it opts in. */
export const DEFAULT_DISABLED_CLASSES: readonly SizeClass[] = VIDEO_LADDER.filter(
  (v) => v.optional,
).map((v) => v.sizeClass);

export interface VideoSource {
  readonly longEdge: number;
  readonly bitrate: number;
  readonly durationSeconds: number;
}

/**
 * Whether a transcode class would actually change anything.
 *
 * **The no-op clause**: if both resolution and bitrate would be unchanged, do
 * not transcode — use the original. Re-encoding a 480p 800 kbps clip into
 * "720p" produces a file that is no better, probably larger, and definitely
 * lossier. Such a clip is its own `video-720p`.
 */
export function transcodeWouldChangeAnything(
  spec: VideoClassSpec,
  source: VideoSource,
): boolean {
  if (spec.kind !== "transcode") return true;
  const resolutionDrops = source.longEdge > spec.maxLongEdge;
  const bitrateDrops = spec.maxBitrate !== undefined && source.bitrate > spec.maxBitrate;
  return resolutionDrops || bitrateDrops;
}

/**
 * Speed-up factor for `video-skim`.
 *
 * Skim is **exempt from the no-op clause** and generated for every video,
 * because it differs from its source in the *time* dimension — a 15-second clip
 * has no smaller resolution worth making but still benefits from a 2-second
 * scrub. The factor caps output at roughly {@link SKIM_TARGET_SECONDS}.
 *
 * These parameters are a hypothesis, not a measurement — the plan says so
 * explicitly, and skim may well be better as an animated AVIF than as a video.
 * Measure against real clips of varying length before treating them as fixed.
 */
export const SKIM_MIN_SPEED = 8;
export const SKIM_TARGET_SECONDS = 20;
export const SKIM_FPS = 2;

export function skimSpeedFactor(durationSeconds: number): number {
  return Math.max(SKIM_MIN_SPEED, durationSeconds / SKIM_TARGET_SECONDS);
}

/** Which video classes apply to a source, honouring both maxima and the no-op clause. */
export function applicableVideoClasses(
  source: VideoSource,
  enabledOptional: readonly SizeClass[] = [],
): VideoClassSpec[] {
  const out: VideoClassSpec[] = [];
  for (const spec of VIDEO_LADDER) {
    if (spec.optional && !enabledOptional.includes(spec.sizeClass)) continue;

    if (spec.kind === "skim") {
      // Exempt: always generated.
      out.push(spec);
      continue;
    }
    if (spec.kind === "poster") {
      // Posters follow the still Rule 2 against the previous poster rung.
      const posters = VIDEO_LADDER.filter((v) => v.kind === "poster");
      const index = posters.indexOf(spec);
      if (index === 0 || source.longEdge > posters[index - 1]!.maxLongEdge) out.push(spec);
      continue;
    }
    // Transcodes: generate only when the class would actually change something.
    if (transcodeWouldChangeAnything(spec, source)) out.push(spec);
  }
  return out;
}
