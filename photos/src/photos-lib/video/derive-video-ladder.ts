/**
 * Deriving a video's rendition ladder (item 27).
 *
 * The ladder rules already exist and are tested — which classes apply, the
 * no-op clause, the skim exemption. This is what turns those decisions into
 * bytes, and it is deliberately the only place that knows both.
 *
 * ## Partial success is the normal outcome, not an error
 *
 * A clip can yield a poster and fail to transcode: the poster is one keyframe
 * and the transcode is minutes of encoding that can hit a codec the build lacks
 * or a timeout. Throwing away the poster because the transcode failed would
 * leave the grid with a hole for a video whose thumbnail was sitting right
 * there. So every class is attempted independently and reported independently,
 * and the caller decides what "complete enough" means.
 */

import {
  applicableVideoClasses,
  skimSpeedFactor,
  SKIM_FPS,
  type SizeClass,
  type VideoClassSpec,
  type VideoSource,
} from "../ladder";
import { displayLongEdge, type VideoFacts } from "./probe";
import { posterTimestamp, UnsupportedVideoError, type VideoTools } from "./video-tools";

export interface DerivedVideoRendition {
  readonly sizeClass: SizeClass;
  readonly bytes: Uint8Array;
  /** MIME type of the produced bytes — posters are stills, the rest are video. */
  readonly contentType: string;
  readonly kind: VideoClassSpec["kind"];
  /**
   * Measured from the produced bytes, never predicted.
   *
   * Variant resolution orders renditions by long edge, so a rendition with no
   * dimensions is invisible to it — storage nobody ever reads.
   */
  readonly width: number;
  readonly height: number;
  readonly durationMs?: number;
  /**
   * The core type this record registers as.
   *
   * A poster is genuinely an image and must register as one: it is what the
   * grid paints, and an image-granted app that cannot see it would be looking
   * at a library with holes where the videos are.
   */
  readonly type: "image" | "video";
}

export interface VideoDerivationFailure {
  readonly sizeClass: SizeClass;
  readonly reason: string;
  /** True when this build can never produce the class — do not retry. */
  readonly terminal: boolean;
}

export interface VideoLadderResult {
  readonly facts: VideoFacts;
  readonly renditions: readonly DerivedVideoRendition[];
  readonly failures: readonly VideoDerivationFailure[];
}

/** The source shape the ladder's maxima compare against. */
export function videoSourceOf(facts: VideoFacts): VideoSource {
  return {
    longEdge: displayLongEdge(facts),
    // A container with no declared bitrate is treated as unbounded rather than
    // as zero. Zero would read as "already below every ceiling" and suppress
    // every transcode — the wrong answer in the direction that silently ships
    // no renditions at all.
    bitrate: facts.bitrate ?? Number.POSITIVE_INFINITY,
    durationSeconds: facts.durationMs / 1000,
  };
}

export async function deriveVideoLadder(
  path: string,
  tools: VideoTools,
  enabledOptional: readonly SizeClass[] = [],
): Promise<VideoLadderResult> {
  // A missing ffmpeg is terminal, not transient: retrying it every sweep burns
  // the whole run rediscovering that it is still not installed.
  if (!(await tools.available())) {
    throw new UnsupportedVideoError("ffmpeg/ffprobe not available on this node");
  }

  const facts = await tools.probe(path);
  const source = videoSourceOf(facts);
  const classes = applicableVideoClasses(source, enabledOptional);

  const renditions: DerivedVideoRendition[] = [];
  const failures: VideoDerivationFailure[] = [];

  for (const spec of classes) {
    try {
      renditions.push(await deriveOne(path, tools, spec, source));
    } catch (err) {
      // Recorded per class rather than thrown, so one failed transcode does not
      // discard the poster that already succeeded.
      failures.push({
        sizeClass: spec.sizeClass,
        reason: (err as Error).message,
        terminal: err instanceof UnsupportedVideoError,
      });
    }
  }

  return { facts, renditions, failures };
}

async function deriveOne(
  path: string,
  tools: VideoTools,
  spec: VideoClassSpec,
  source: VideoSource,
): Promise<DerivedVideoRendition> {
  switch (spec.kind) {
    case "poster": {
      const out = await tools.extractPoster(path, {
        atSeconds: posterTimestamp(source.durationSeconds),
        maxLongEdge: spec.maxLongEdge,
      });
      return {
        sizeClass: spec.sizeClass,
        bytes: out.bytes,
        width: out.width,
        height: out.height,
        contentType: "image/jpeg",
        kind: "poster",
        // Registered as an image, not a video: it is what the grid paints, and
        // an image-granted app that could not see it would show a library with
        // holes where the videos are.
        type: "image",
      };
    }
    case "skim": {
      const out = await tools.skim(path, {
        maxLongEdge: spec.maxLongEdge,
        speedFactor: skimSpeedFactor(source.durationSeconds),
        fps: SKIM_FPS,
      });
      return {
        sizeClass: spec.sizeClass,
        bytes: out.bytes,
        width: out.width,
        height: out.height,
        ...(out.durationMs !== undefined ? { durationMs: out.durationMs } : {}),
        contentType: "video/mp4",
        kind: "skim",
        type: "video",
      };
    }
    case "transcode": {
      const out = await tools.transcode(path, {
        maxLongEdge: spec.maxLongEdge,
        // applicableVideoClasses only yields a transcode class when it would
        // change something, so maxBitrate is always set by then. The fallback
        // exists so a hand-built spec cannot produce `-b:v undefined`.
        maxBitrate: spec.maxBitrate ?? 1_500_000,
      });
      return {
        sizeClass: spec.sizeClass,
        bytes: out.bytes,
        width: out.width,
        height: out.height,
        ...(out.durationMs !== undefined ? { durationMs: out.durationMs } : {}),
        contentType: "video/mp4",
        kind: "transcode",
        type: "video",
      };
    }
  }
}

/**
 * Which classes a record is still missing.
 *
 * Mirrors the still ladder's equivalent so the archive gate can ask one
 * question of both kinds of media.
 */
export function missingVideoClasses(
  facts: VideoFacts,
  existing: readonly SizeClass[],
  enabledOptional: readonly SizeClass[] = [],
): SizeClass[] {
  const have = new Set(existing);
  return applicableVideoClasses(videoSourceOf(facts), enabledOptional)
    .map((spec) => spec.sizeClass)
    .filter((sizeClass) => !have.has(sizeClass));
}

export function videoLadderIsComplete(
  facts: VideoFacts,
  existing: readonly SizeClass[],
  enabledOptional: readonly SizeClass[] = [],
): boolean {
  return missingVideoClasses(facts, existing, enabledOptional).length === 0;
}
