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
 * ## Every rung is a platform stand-in
 *
 * The platform publishes the stand-in standards — the stand-in categories, the
 * allowed formats, the minimum quality, the canonical threshold and the
 * standard sizes — and this ladder is Photos' way of meeting them. See
 * `~/projects/starkeep/exploration-shared-forms-generator-2026-09-27.md`.
 *
 * - Every still rung is a **standard size**, and its long edge is the stand-in's
 *   reported fidelity. `image-large` is the **canonical stand-in**, produced
 *   only for an original the platform may archive; the others are **smaller**
 *   stand-ins.
 * - A rung is produced only **below** the original's long edge. The original —
 *   or its canonical stand-in — serves every larger size, so a 900 px original
 *   has a 320 and a 640 and nothing else. Rungs are never clamped to a small
 *   original any more: a clamped rung would sit between standard sizes, which
 *   the platform refuses.
 * - Posters and skims are **derived records**, not stand-ins: they cannot
 *   replace the video they come from.
 *
 * The constants that mirror the platform's defaults are pinned against
 * `DEFAULT_STAND_IN_STANDARDS` by a test in `photos-mobile`, which links the
 * platform packages; this package deliberately depends on nothing.
 */

/**
 * A derived size class.
 *
 * Photos' own names for its sizes. The platform never sees them: it reads a
 * stand-in by its role and fidelity columns, and a derived record by the
 * `photos/derived` label's value. They appear here only because Photos is the
 * app that owns the ladder.
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

/** A still rung's stand-in role. The top rung is the canonical stand-in. */
export type StandInRole = "canonical" | "smaller";

export interface StillClassSpec {
  readonly sizeClass: SizeClass;
  /**
   * The rung's long edge in pixels, and the stand-in's reported fidelity. A
   * standard size, which is why a rung never clamps to a smaller original.
   */
  readonly maxLongEdge: number;
  /** Canonical for the top rung, smaller for every other. */
  readonly role: StandInRole;
  /** Encoder quality, on the codec's own scale. */
  readonly quality: number;
  /** What this rung is for — the reason its number is what it is. */
  readonly serves: string;
}

/**
 * The minimum AVIF quality the platform's image standard sets, on the 0–100
 * scale libavif and `sharp` expose. Every rung encodes at it.
 */
export const STAND_IN_MIN_QUALITY = 60;

/**
 * The canonical threshold for images: the canonical stand-in's long edge, and
 * the line above which an original archives behind one. `image-large`'s size.
 */
export const IMAGE_CANONICAL_THRESHOLD = 4272;

/**
 * Originals at or below this many bytes never archive, so they take no
 * canonical stand-in whatever their size in pixels. The platform's floor.
 */
export const ARCHIVE_SIZE_FLOOR_BYTES = 1024 * 1024;

/**
 * The canonical threshold for video, in kbps over the whole container: the
 * canonical stand-in's target bitrate, or the original's own bitrate when that
 * is lower. Video fidelity is a bitrate; resolution only caps the encode.
 */
export const VIDEO_CANONICAL_THRESHOLD = 4800;

/** The one smaller video size, in kbps over the whole container. */
export const VIDEO_SMALLER_KBPS = 2000;

/**
 * The still ladder, ascending.
 *
 * Order is load-bearing: `applicableStillClasses` relies on it to produce a
 * contiguous prefix, and the derivation sweeper reads "top applicable class"
 * off that.
 */
export const STILL_LADDER: readonly StillClassSpec[] = [
  {
    sizeClass: "image-xsmall",
    maxLongEdge: 320,
    role: "smaller",
    // The platform's minimum, like every rung. It used to sit at 50 here and
    // at 55 on the next two rungs; the stand-in standard sets one floor for
    // every size, so a smaller stand-in is never worse than the canonical one.
    quality: STAND_IN_MIN_QUALITY,
    // The rung a dense surface degrades to, and the first image frame every
    // other surface paints behind. Transfer stopped deciding anything well
    // before this size (roughly 10 KB an object), so two other costs place the
    // number. Decoded bitmap memory is quadratic and holds a 500-tile screen to
    // about 150 MB here against 230 MB at 400. Legibility places the floor,
    // because anything blurrier already has a free answer in the inline
    // ThumbHash. 320 answers a 160 px tile at 2× and a 107 px tile at 3×, which
    // is where contact sheets and filmstrips sit, and it sits exactly one
    // octave below `image-thumb` so a density cap has one honest step to take.
    serves: "infinite canvas, dense contact-sheet grids, filmstrips",
  },
  {
    sizeClass: "image-thumb",
    maxLongEdge: 640,
    role: "smaller",
    quality: STAND_IN_MIN_QUALITY,
    // Sized to the list's two defaults rather than to a round number: a 320 px
    // desktop row at 2× asks for exactly 640, and a 180 px mobile row at 3×
    // asks for 540. Both figures describe a portrait photo, which dominates a
    // phone-sourced library. Landscape tiles still round up to `image-medium`.
    serves: "grid tiles, list rows",
  },
  {
    sizeClass: "image-medium",
    maxLongEdge: 1280,
    role: "smaller",
    quality: STAND_IN_MIN_QUALITY,
    // The AI rung. Every routine model input is ≤640 px, so this has 2× headroom
    // and `image-screen` would ship and decode 4× the pixels a model consumes.
    serves: "all routine on-device AI, fullscreen stage 1, share/export default",
  },
  {
    sizeClass: "image-screen",
    maxLongEdge: 2560,
    role: "smaller",
    quality: STAND_IN_MIN_QUALITY,
    serves: "phone fullscreen, laptop, AI re-crops of small subjects",
  },
  {
    sizeClass: "image-large",
    maxLongEdge: 4272,
    role: "canonical",
    quality: STAND_IN_MIN_QUALITY,
    serves: "4K TV, laptop retina fullscreen, zoom, OCR, print preview",
  },
];

/**
 * Whether an original of this long edge and size archives behind a canonical
 * stand-in. The platform's rule: past the size floor and above the threshold.
 *
 * `sizeBytes` is optional because some callers resolve a request before they
 * know the file's size; they are answered as though the original were past the
 * floor, which is the case for every photograph above 4272 px in practice.
 */
export function stillTakesCanonical(originalLongEdge: number, sizeBytes?: number | null): boolean {
  if (sizeBytes !== undefined && sizeBytes !== null && sizeBytes <= ARCHIVE_SIZE_FLOOR_BYTES) return false;
  return originalLongEdge > IMAGE_CANONICAL_THRESHOLD;
}

/**
 * Which still rungs an original takes, ascending.
 *
 * Every smaller rung strictly below the original's long edge, and the
 * canonical rung when the original archives behind one. A 300 px original
 * takes nothing: it is self-canonical and small enough to serve itself at
 * every size.
 *
 * The set is still a contiguous prefix from the bottom, which the sweeper and
 * the derivation stages rely on.
 */
export function applicableStillClasses(
  originalLongEdge: number,
  sizeBytes?: number | null,
): StillClassSpec[] {
  const canonical = stillTakesCanonical(originalLongEdge, sizeBytes);
  return STILL_LADDER.filter((spec) =>
    spec.role === "canonical" ? canonical : spec.maxLongEdge < originalLongEdge,
  );
}

/**
 * The long edge that answers every request at or above it: the canonical
 * stand-in's, or the original's own when the original is self-canonical.
 */
export function stillTopLongEdge(originalLongEdge: number, sizeBytes?: number | null): number {
  return stillTakesCanonical(originalLongEdge, sizeBytes) ? IMAGE_CANONICAL_THRESHOLD : originalLongEdge;
}

/**
 * Which rung answers a request for this many pixels.
 *
 * **Round up**: the smallest class whose maximum reaches the target, and the
 * top class when nothing does. Rounding down would hand a 2× display a 320 px
 * file for a 360 px need — close to a twofold undersample, and a worse outcome
 * than the extra bytes it saves.
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

/**
 * The long edge a class emits for this original: its own size. Applicable
 * rungs all sit below the original, so nothing clamps; the `min` stays as a
 * guard against a caller asking about a rung the original does not take.
 */
export function renditionLongEdge(spec: StillClassSpec, originalLongEdge: number): number {
  return Math.min(originalLongEdge, spec.maxLongEdge);
}

/**
 * The largest class that applies, or null when the original takes none — a
 * small original that serves itself at every size.
 */
export function topApplicableStillClass(
  originalLongEdge: number,
  sizeBytes?: number | null,
): StillClassSpec | null {
  const applicable = applicableStillClasses(originalLongEdge, sizeBytes);
  return applicable[applicable.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

export interface VideoClassSpec {
  readonly sizeClass: SizeClass;
  /**
   * The largest long edge the class encodes at. For a transcode this is the
   * platform's advisory resolution: it guides the encoder, and no rule reads
   * it, because a video stand-in's fidelity is its bitrate.
   */
  readonly maxLongEdge: number;
  /**
   * A transcode's target bitrate in kbps over the whole container — the
   * stand-in's reported fidelity. The canonical transcode lowers it to the
   * source's own bitrate; see {@link transcodeKbps}.
   */
  readonly targetKbps?: number;
  /**
   * Poster and skim classes are stills / sampled sequences — derived records
   * that cannot replace the video. Transcodes are stand-ins.
   */
  readonly kind: "poster" | "skim" | "transcode";
  /** A transcode's stand-in role; absent on posters and skims. */
  readonly role?: StandInRole;
  readonly serves: string;
}

/**
 * The libvpx-vp9 CRF every video stand-in encodes at, in constrained-quality
 * mode: the target bitrate caps the file, and the CRF stops the encoder
 * spending bits a quiet scene does not need. Lower is better.
 */
export const VIDEO_STAND_IN_CRF = 31;

export const VIDEO_LADDER: readonly VideoClassSpec[] = [
  {
    sizeClass: "video-poster-thumb",
    // Pinned to `image-thumb` rather than chosen independently: a video and a
    // still sit in the same justified row at the same height, so a poster
    // smaller than the still rung would make videos the visibly softer tiles in
    // a mixed grid, and a larger one would make them the expensive ones.
    maxLongEdge: 640,
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
    targetKbps: VIDEO_SMALLER_KBPS,
    kind: "transcode",
    role: "smaller",
    serves: "inline playback",
  },
  {
    // The canonical stand-in, which every video takes: at the threshold
    // bitrate, or the video's own when lower, and at the video's own long edge
    // up to 1080p, in VP9 WebM that every current browser plays. Named for its
    // usual size; a 1440 px clip's canonical stand-in is 1440 px.
    sizeClass: "video-1080p",
    maxLongEdge: 1920,
    targetKbps: VIDEO_CANONICAL_THRESHOLD,
    kind: "transcode",
    role: "canonical",
    serves: "TV / large-screen playback, and what the person sees once the original is archived",
  },
];

/**
 * Classes a library does not generate unless it opts in. None now: the
 * canonical transcode is what lets a video's original archive, so it cannot
 * be optional.
 */
export const DEFAULT_DISABLED_CLASSES: readonly SizeClass[] = [];

export interface VideoSource {
  readonly longEdge: number;
  /**
   * Whole-container bitrate in bits per second. Infinite when the container
   * declares none and its size and duration cannot answer.
   */
  readonly bitrate: number;
  readonly durationSeconds: number;
}

/**
 * A video's fidelity: its whole-container bitrate in kbps, rounded to a whole
 * number, which is how the platform ranks video. Null when unknown.
 */
export function videoFidelityKbps(source: Pick<VideoSource, "bitrate">): number | null {
  return Number.isFinite(source.bitrate) && source.bitrate > 0 ? Math.round(source.bitrate / 1000) : null;
}

/**
 * Whether a transcode class applies to a source.
 *
 * The canonical transcode always does — every video original gets one, even a
 * small H.264 clip, and the platform decides from its size whether it replaces
 * the original. The smaller transcode applies only below the source's own
 * bitrate, as every smaller stand-in sits below its original's fidelity; an
 * unknown bitrate counts as above.
 */
export function transcodeWouldChangeAnything(
  spec: VideoClassSpec,
  source: VideoSource,
): boolean {
  if (spec.kind !== "transcode") return true;
  if (spec.role === "canonical") return true;
  const kbps = videoFidelityKbps(source);
  return kbps === null || kbps > spec.targetKbps!;
}

/**
 * The long edge a transcode class emits for a source: the class's advisory
 * long edge, never above the source's own.
 */
export function transcodeLongEdge(spec: VideoClassSpec, source: Pick<VideoSource, "longEdge">): number {
  return Math.min(spec.maxLongEdge, source.longEdge);
}

/**
 * The bitrate a transcode class targets for a source, in kbps over the whole
 * container, and the stand-in's reported fidelity: the class's target, and
 * for the canonical transcode never above the source's own bitrate.
 */
export function transcodeKbps(spec: VideoClassSpec, sourceKbps: number | null): number {
  const target = spec.targetKbps!;
  if (spec.role !== "canonical" || sourceKbps === null) return target;
  return Math.min(target, sourceKbps);
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

/**
 * Which video classes apply to a source. `enabledOptional` is kept for callers
 * that still pass it; no class is optional any more.
 */
export function applicableVideoClasses(
  source: VideoSource,
  enabledOptional: readonly SizeClass[] = [],
): VideoClassSpec[] {
  void enabledOptional;
  const out: VideoClassSpec[] = [];
  for (const spec of VIDEO_LADDER) {
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
    // Transcodes: the canonical one always, the smaller one below the source.
    if (transcodeWouldChangeAnything(spec, source)) out.push(spec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rungs as platform stand-ins
// ---------------------------------------------------------------------------

/** What the platform is told about a rung: its role and its fidelity. */
export interface StandInFields {
  readonly role: StandInRole;
  readonly fidelity: number;
}

/**
 * The stand-in a rung is, for an original of this fidelity — its long edge for
 * a still, its bitrate in kbps for a video — or null for a poster or a skim,
 * which are derived records.
 */
export function standInFieldsFor(sizeClass: SizeClass, sourceFidelity: number | null): StandInFields | null {
  const still = STILL_LADDER.find((spec) => spec.sizeClass === sizeClass);
  if (still) return { role: still.role, fidelity: still.maxLongEdge };
  const video = VIDEO_LADDER.find((spec) => spec.sizeClass === sizeClass);
  if (video?.kind === "transcode" && video.role) {
    return { role: video.role, fidelity: transcodeKbps(video, sourceFidelity) };
  }
  return null;
}

/**
 * The rung a platform stand-in is, read back — the inverse of
 * {@link standInFieldsFor}. Null for a stand-in at a size this ladder does not
 * name, which another app may have produced at a standard size Photos skips.
 */
export function classForStandIn(
  category: "image" | "video",
  role: StandInRole,
  fidelity: number,
): SizeClass | null {
  if (category === "video") {
    const spec = VIDEO_LADDER.find((v) => v.kind === "transcode" && v.role === role);
    if (!spec) return null;
    return role === "canonical" || fidelity === spec.targetKbps ? spec.sizeClass : null;
  }
  return STILL_LADDER.find((s) => s.role === role && s.maxLongEdge === fidelity)?.sizeClass ?? null;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * What a published still rung is called.
 *
 * Here rather than beside either publisher because two nodes now derive: a
 * machine running `sharp` and a phone running `avif-coder`. The name is part of
 * a record's content-addressed id — `(parent, filename, contentHash)` — so two
 * spellings of it are two ids for the same rung of the same photograph, which
 * nothing downstream would ever reconcile.
 *
 * No extension is appended, deliberately, and the video publisher's own rule is
 * the reason it can stay that way: a poster changes container relative to its
 * parent, so it has to say so, while a still rung's name is only ever read as a
 * label and its type travels in the record.
 */
export function renditionFileName(originalFilename: string | null, sizeClass: string): string {
  const base = originalFilename ?? "image";
  return `${sizeClass}_${base}`;
}
