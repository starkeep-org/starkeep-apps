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
    case "poster":
      return {
        sizeClass: spec.sizeClass,
        bytes: await tools.extractPoster(path, {
          atSeconds: posterTimestamp(source.durationSeconds),
          maxLongEdge: spec.maxLongEdge,
        }),
        contentType: "image/jpeg",
        kind: "poster",
      };
    case "skim":
      return {
        sizeClass: spec.sizeClass,
        bytes: await tools.skim(path, {
          maxLongEdge: spec.maxLongEdge,
          speedFactor: skimSpeedFactor(source.durationSeconds),
          fps: SKIM_FPS,
        }),
        contentType: "video/mp4",
        kind: "skim",
      };
    case "transcode":
      return {
        sizeClass: spec.sizeClass,
        bytes: await tools.transcode(path, {
          maxLongEdge: spec.maxLongEdge,
          // applicableVideoClasses only yields a transcode class when it would
          // change something, so maxBitrate is always set by then. The fallback
          // exists so a hand-built spec cannot produce `-b:v undefined`.
          maxBitrate: spec.maxBitrate ?? 1_500_000,
        }),
        contentType: "video/mp4",
        kind: "transcode",
      };
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
