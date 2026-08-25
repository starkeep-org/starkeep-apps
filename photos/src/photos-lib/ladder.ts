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
  | "image-xsmall"
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
    sizeClass: "image-xsmall",
    maxLongEdge: 128,
    // Not pushed below `image-thumb`'s quality even though artifacts hide more
    // easily at this size. The absolute saving is a couple of kilobytes — both
    // rungs are far under the 128 KB Intelligent-Tiering floor and cost the
    // Standard rate either way — so a lower number buys nothing measurable and
    // risks mush on the one asset a dense canvas paints hundreds of at once.
    quality: 50,
    // Below the point where a tile is read as an image at all: this is the rung
    // for a canvas showing hundreds of records at once, where the alternative is
    // shipping hundreds of 400 px tiles (~10× the pixels) to draw them at 128.
    serves: "infinite canvas, dense contact-sheet grids, filmstrips",
  },
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

/**
 * Which rung answers a request for this many pixels.
 *
 * **Round up**: the smallest class whose maximum reaches the target, and the
 * top class when nothing does. Rounding down would hand a 2× display a 128 px
 * file for a 360 px need — a threefold undersample, and a worse outcome than
 * the extra bytes it saves.
 *
 * Resolved against class *maxima* rather than against a particular original,
 * because this answers "which rung is being asked for" for a caller that knows
 * only a pixel count. Whether that rung applies to a given record is a separate
 * question, and {@link applicableStillClasses} is the one that answers it.
 */
export function classForTargetLongEdge(target: number): SizeClass {
  for (const spec of STILL_LADDER) {
    if (spec.maxLongEdge >= target) return spec.sizeClass;
  }
  return STILL_LADDER[STILL_LADDER.length - 1]!.sizeClass;
}

/**
 * The rungs cheap enough to produce inside a request, once the source has been
 * decoded.
 *
 * The decode is the expensive part and it is already paid, so adding these to
 * whatever was actually asked for costs a few tens of milliseconds — against
 * re-downloading and re-decoding a 7 MB original later to get them. This is
 * what a Lambda with a third of a core and thirty seconds can commit to; the
 * rungs above are the owning node's work.
 */
export const CHEAP_STILL_CLASSES: readonly SizeClass[] = ["image-xsmall", "image-thumb"];

/**
 * The largest long edge the cheap tier covers.
 *
 * A caller that can only afford {@link CHEAP_STILL_CLASSES} asks for this, and
 * round-up resolution lands it on the top cheap rung. Derived from the ladder
 * rather than written down, so a respecification cannot leave it behind.
 */
export const CHEAP_TARGET_LONG_EDGE: number = Math.max(
  ...CHEAP_STILL_CLASSES.map(
    (c) => STILL_LADDER.find((s) => s.sizeClass === c)!.maxLongEdge,
  ),
);

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
  /** Poster and skim classes are stills / sampled sequences, not transcodes. */
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
    maxLongEdge: 320,
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
 * The sampling cadence for `video-skim`: one second of footage out of every ten.
 *
 * Skim is **exempt from the no-op clause** and generated for every video,
 * because it differs from its source in the *time* dimension — a 15-second clip
 * has no smaller resolution worth making but still benefits from a scrub.
 *
 * ## Why sampled segments rather than a sped-up whole
 *
 * The earlier shape played the entire clip at 8× and 2 fps. That is legible for
 * a static scene and useless for anything with motion: at 2 fps a person walking
 * across the frame is four disconnected poses, and speeding the timeline up
 * strips the one cue — how things actually move — that tells you what a clip is
 * of. Sampled segments keep real motion at real speed inside each window and
 * simply skip what is between them, which is how a person scrubbing a timeline
 * looks at a video anyway.
 *
 * ## The consequence to build against
 *
 * Output length is **proportional to the source**, at one tenth of it, where the
 * previous shape capped it near 20 seconds however long the clip. A 2-minute
 * clip skims in 12 seconds; a 1-hour clip skims in 6 minutes, and its skim is
 * the largest derived asset that record has. If long-video libraries turn out to
 * be common, the cap belongs here as a maximum segment count, not in the ffmpeg
 * arguments.
 *
 * These parameters are a hypothesis, not a measurement, and skim may well be
 * better as an animated AVIF than as a video. Measure against real clips of
 * varying length before treating them as fixed.
 */
export const SKIM_SEGMENT_SECONDS = 1;
export const SKIM_INTERVAL_SECONDS = 10;

/**
 * How long the skim of a clip this long comes out.
 *
 * A full segment per whole interval, plus whatever the trailing partial interval
 * contributes — a 25-second clip samples at 0, 10 and 20 seconds for 3 seconds
 * out, and a 10.5-second clip gets 1.5, not 2.
 *
 * Exists so callers can budget storage and so tests can assert the cadence
 * without restating the arithmetic.
 */
export function skimDurationSeconds(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const wholeIntervals = Math.floor(durationSeconds / SKIM_INTERVAL_SECONDS);
  const trailing = durationSeconds - wholeIntervals * SKIM_INTERVAL_SECONDS;
  return wholeIntervals * SKIM_SEGMENT_SECONDS + Math.min(trailing, SKIM_SEGMENT_SECONDS);
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
