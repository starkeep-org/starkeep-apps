/**
 * Running ffmpeg / ffprobe (items 26 and 27).
 *
 * ## Why this is a port rather than a direct dependency
 *
 * Video derivation genuinely needs ffmpeg — there is no pure-JS transcoder
 * worth shipping. But ffmpeg is an ~80 MB binary, and bundling `ffmpeg-static`
 * would put it in every install of this app whether or not that install ever
 * derives a video. So the binary is *discovered* rather than depended on: where
 * it exists (a developer laptop, a container that installed it, a Lambda layer)
 * derivation works, and where it does not the ladder reports the classes it
 * could not produce instead of crashing the import.
 *
 * That degradation has to be honest. A missing ffmpeg is **not** a transient
 * failure and must not be retried every sweep — it is exactly the `unsupported`
 * case the import ledger already models, and treating it as `failed` would burn
 * every subsequent run re-discovering that ffmpeg is still not installed.
 *
 * The port also exists so the derivation logic is testable without invoking a
 * subprocess per case. The interesting decisions — which classes to build, what
 * timestamp to grab, whether to transcode at all — are pure, and a fake
 * implementation exercises them in milliseconds.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { VideoFacts } from "./probe";
import { parseProbeOutput } from "./probe";

const run = promisify(execFile);

/** Thrown for a source this build cannot process. Terminal — never retried. */
export class UnsupportedVideoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedVideoError";
  }
}

export interface PosterOptions {
  /** Seconds into the clip to grab. */
  readonly atSeconds: number;
  readonly maxLongEdge: number;
}

export interface TranscodeOptions {
  readonly maxLongEdge: number;
  readonly maxBitrate: number;
  /**
   * Container/codec pair. H.264 in MP4 by default because it is the only
   * combination that plays everywhere without a fallback; VP9/WebM is smaller
   * at equal quality but is a deliberate opt-in, not a default.
   */
  readonly codec?: "h264" | "vp9";
}

export interface SkimOptions {
  readonly maxLongEdge: number;
  /** Seconds of footage kept from the start of each interval, at source speed. */
  readonly segmentSeconds: number;
  /** How often a segment is taken, in seconds of source. */
  readonly intervalSeconds: number;
}

/**
 * Everything derivation needs from the outside world.
 *
 * Paths in, bytes out: ffmpeg wants real files (it seeks, and it writes
 * containers that need a seekable output), so pretending the interface is
 * stream-shaped would mean writing temp files anyway, in a place the caller
 * cannot control.
 */
export interface VideoTools {
  /** Whether the tools are actually present. Cheap; result is cached. */
  available(): Promise<boolean>;
  probe(path: string): Promise<VideoFacts>;
  extractPoster(path: string, options: PosterOptions): Promise<DerivedOutput>;
  transcode(path: string, options: TranscodeOptions): Promise<DerivedOutput>;
  skim(path: string, options: SkimOptions): Promise<DerivedOutput>;
}

/**
 * Produced bytes together with their real dimensions.
 *
 * Dimensions are **measured from the output**, not computed from the source and
 * the requested maximum. The scale filter rounds the free axis to an even number
 * (`-2`), so a computed value is off by one often enough to matter — and these
 * numbers are what variant resolution orders renditions by. A rendition whose
 * dimensions are missing is invisible to resolution and becomes storage nobody
 * ever reads; one whose dimensions are subtly wrong is worse, because it sorts
 * into the wrong place and is served at the wrong size.
 *
 * The measurement is free: the output is already on disk for `faststart`, so
 * this is one ffprobe against a local file, against seconds of encoding.
 */
export interface DerivedOutput {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Present for video outputs; posters are a single frame. */
  readonly durationMs?: number;
}

/**
 * Where to grab the poster frame.
 *
 * Not frame zero. The first frame of real footage is very often black or nearly
 * so — a fade-in, an auto-exposure ramp, a phone camera whose sensor has not
 * settled — and a library whose video tiles are uniformly black squares looks
 * broken in a way that is entirely self-inflicted.
 *
 * A tenth of the way in avoids that on ordinary clips, capped at one second so
 * that a long video does not grab its poster from a minute deep, by which point
 * the scene may have nothing to do with what the clip is *of*.
 */
export const POSTER_MAX_OFFSET_SECONDS = 1;

export function posterTimestamp(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.min(POSTER_MAX_OFFSET_SECONDS, durationSeconds / 10);
}

/**
 * Scale filter that never upscales.
 *
 * `min(iw,N)` rather than a flat target: the ladder's maxima rule is that a
 * rendition is never larger than its source, and ffmpeg will happily upscale a
 * 480p clip to 720p, producing a bigger file with no more detail. `-2` keeps
 * the other axis proportional *and* even, which H.264's chroma subsampling
 * requires — an odd dimension is a hard encoder error, not a rounding warning.
 */
export function scaleFilter(maxLongEdge: number, portrait: boolean): string {
  return portrait
    ? `scale=-2:'min(ih,${maxLongEdge})'`
    : `scale='min(iw,${maxLongEdge})':-2`;
}

export interface FfmpegToolsOptions {
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  /** Guard against a corrupt file that makes ffmpeg spin. */
  readonly timeoutMs?: number;
  /**
   * Cap on bytes read back from a derivation.
   *
   * execFile buffers stdout in memory, so an unbounded transcode of a large
   * source would be read entirely into the heap. The ladder's outputs are
   * bounded by construction (720p at 1.5 Mbps), so a generous ceiling here only
   * ever trips on something that has already gone wrong.
   */
  readonly maxOutputBytes?: number;
}

export function createFfmpegTools(options: FfmpegToolsOptions = {}): VideoTools {
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";
  const ffprobe = options.ffprobePath ?? "ffprobe";
  const timeout = options.timeoutMs ?? 10 * 60_000;
  const maxBuffer = options.maxOutputBytes ?? 512 * 1024 * 1024;

  let availability: Promise<boolean> | null = null;

  /** Measure a produced file, so dimensions are observed rather than predicted. */
  async function measure(path: string): Promise<{ width: number; height: number; durationMs?: number }> {
    const { stdout } = await run(
      ffprobe,
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const json = JSON.parse(stdout) as {
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
      format?: { duration?: string };
    };
    const stream = json.streams?.find((s) => s.codec_type === "video");
    const durationSeconds = Number(json.format?.duration ?? 0);
    return {
      width: stream?.width ?? 0,
      height: stream?.height ?? 0,
      ...(Number.isFinite(durationSeconds) && durationSeconds > 0
        ? { durationMs: Math.round(durationSeconds * 1000) }
        : {}),
    };
  }

  /**
   * Run ffmpeg into a temporary file and hand back the bytes.
   *
   * Video output cannot go down a pipe. `-movflags +faststart` relocates the
   * moov atom to the front of the file, which it does by writing the file and
   * then rewriting it — so ffmpeg refuses outright with "muxer does not support
   * non seekable output". Dropping faststart would make it pipeable and defeat
   * the point: moov-at-front is precisely what lets a player start on the first
   * range request instead of downloading the whole file first.
   *
   * The alternative, a fragmented MP4 (`frag_keyframe+empty_moov`), does pipe
   * cleanly, but it carries per-fragment overhead and is the wrong shape for
   * progressive seeking. A temp file is the cheaper trade.
   */
  async function ffmpegToFile(
    args: (out: string) => string[],
    suffix: string,
  ): Promise<DerivedOutput> {
    const out = join(await mkdtemp(join(tmpdir(), "photos-video-")), `out${suffix}`);
    try {
      await run(ffmpeg, args(out), { timeout, maxBuffer: 1024 * 1024, encoding: "buffer" });
      // Measured while the file is still on disk. Predicting these from the
      // source and the requested maximum would be wrong by the scale filter's
      // even-number rounding, and these are the numbers variant resolution
      // orders by.
      const measured = await measure(out);
      const bytes = new Uint8Array(await readFile(out));
      if (bytes.byteLength > maxBuffer) {
        throw new Error(`derived output is ${bytes.byteLength} bytes, over the ${maxBuffer} cap`);
      }
      return { bytes, ...measured };
    } finally {
      await rm(dirname(out), { recursive: true, force: true });
    }
  }

  return {
    async available(): Promise<boolean> {
      availability ??= (async () => {
        try {
          await run(ffprobe, ["-version"], { timeout: 10_000 });
          await run(ffmpeg, ["-version"], { timeout: 10_000 });
          return true;
        } catch {
          return false;
        }
      })();
      return availability;
    },

    async probe(path: string): Promise<VideoFacts> {
      let stdout: string;
      try {
        ({ stdout } = await run(
          ffprobe,
          ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
          { timeout, maxBuffer: 8 * 1024 * 1024 },
        ));
      } catch (err) {
        throw new UnsupportedVideoError(`ffprobe could not read ${path}: ${(err as Error).message}`);
      }
      const facts = parseProbeOutput(JSON.parse(stdout));
      if (!facts) {
        // Parsed fine and contains no video — an audio-only file with a video
        // extension is a real thing in a camera-roll export, and retrying it
        // forever would be the wrong answer.
        throw new UnsupportedVideoError(`no video stream in ${path}`);
      }
      return facts;
    },

    async extractPoster(path: string, opts: PosterOptions): Promise<DerivedOutput> {
      const facts = await this.probe(path);
      // To a file rather than a pipe, for the same reason the video outputs
      // are: the dimensions have to be measured from the result, and variant
      // resolution depends on them being exact.
      return ffmpegToFile(
        (out) => [
          "-y",
          // -ss before -i seeks by keyframe without decoding everything up to
          // that point. On a long clip the difference is seconds versus minutes.
          "-ss", String(opts.atSeconds),
          "-i", path,
          "-frames:v", "1",
          "-vf", `${transposeFilter(facts.rotation)}${scaleFilter(opts.maxLongEdge, facts.height > facts.width)}`,
          "-c:v", "mjpeg",
          "-q:v", "3",
          out,
        ],
        ".jpg",
      );
    },

    async transcode(path: string, opts: TranscodeOptions): Promise<DerivedOutput> {
      const facts = await this.probe(path);
      const vp9 = opts.codec === "vp9";
      return ffmpegToFile(
        (out) => [
          "-y",
          "-i", path,
          "-vf", `${transposeFilter(facts.rotation)}${scaleFilter(opts.maxLongEdge, facts.height > facts.width)}`,
          "-c:v", vp9 ? "libvpx-vp9" : "libx264",
          ...(vp9 ? [] : ["-preset", "medium", "-profile:v", "high", "-pix_fmt", "yuv420p"]),
          "-b:v", String(opts.maxBitrate),
          "-maxrate", String(opts.maxBitrate),
          "-bufsize", String(opts.maxBitrate * 2),
          "-c:a", vp9 ? "libopus" : "aac",
          "-b:a", "128k",
          // Relocate the index to the front so playback can start on the first
          // range request. Without it a progressive MP4 has to be downloaded in
          // full before the first frame shows, which defeats ranged serving
          // entirely — and it is why this cannot be piped.
          ...(vp9 ? [] : ["-movflags", "+faststart"]),
          out,
        ],
        vp9 ? ".webm" : ".mp4",
      );
    },

    async skim(path: string, opts: SkimOptions): Promise<DerivedOutput> {
      const facts = await this.probe(path);
      return ffmpegToFile(
        (out) => [
          "-y",
          "-i", path,
          "-vf",
          [
            transposeFilter(facts.rotation).replace(/,$/, "") || null,
            // Keep every frame landing in the first `segmentSeconds` of each
            // `intervalSeconds` window, at source speed and source frame rate.
            // Quoted so the filtergraph parser does not read the commas inside
            // the expression as filter separators.
            `select='lt(mod(t\\,${opts.intervalSeconds})\\,${opts.segmentSeconds})'`,
            // Mandatory, and the whole reason the output is short. `select`
            // drops frames without touching their timestamps, so without this
            // the segments keep their original presentation times: a 10-minute
            // container with a one-second burst of motion every ten seconds and
            // a frozen frame in between. Renumbering to N/FRAME_RATE makes the
            // kept frames contiguous, which is what makes the file one tenth of
            // the source rather than the same length with holes in it.
            "setpts=N/FRAME_RATE/TB",
            scaleFilter(opts.maxLongEdge, facts.height > facts.width),
          ]
            .filter(Boolean)
            .join(","),
          // No audio track at all. Audio sampled on the same cadence is a
          // sequence of clicks, and a silent track would cost bytes for nothing.
          "-an",
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-pix_fmt", "yuv420p",
          "-movflags", "+faststart",
          out,
        ],
        ".mp4",
      );
    },
  };
}

/**
 * Deliberately empty: ffmpeg applies the display matrix on decode by itself.
 *
 * This is the trap in the obvious direction. Knowing that a portrait phone clip
 * is encoded landscape plus a rotation, the instinct is to bake the rotation in
 * with `transpose`. But ffmpeg's autorotate has been on by default for years,
 * so the frames handed to the filter chain are *already* upright — an explicit
 * transpose rotates a second time and turns a correctly-tagged portrait clip
 * into a landscape rendition of sideways footage.
 *
 * Verified rather than assumed: extracting a frame from a 640x480 clip carrying
 * a 90° matrix yields 480x640 with no filter, and 640x480 under
 * `-noautorotate`. Kept as a named no-op, with a test pinning it, because
 * "obviously we must transpose" is a change someone will make again otherwise.
 *
 * The rotation is still read and stored — {@link VideoFacts.rotation} — because
 * consumers that do their own decoding need it. It just must not be applied
 * here.
 */
export function transposeFilter(_rotation: 0 | 90 | 180 | 270): string {
  return "";
}
