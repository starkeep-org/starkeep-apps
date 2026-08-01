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
  /** Playback speed multiplier — a 10x skim shows a 5-minute clip in 30 seconds. */
  readonly speedFactor: number;
  readonly fps: number;
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
  extractPoster(path: string, options: PosterOptions): Promise<Uint8Array>;
  transcode(path: string, options: TranscodeOptions): Promise<Uint8Array>;
  skim(path: string, options: SkimOptions): Promise<Uint8Array>;
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

  async function ffmpegToStdout(args: string[]): Promise<Uint8Array> {
    const { stdout } = await run(ffmpeg, args, {
      timeout,
      maxBuffer,
      // Binary out. Without this the buffer is decoded as UTF-8 and every byte
      // outside ASCII becomes U+FFFD — a corrupt file that still has a
      // plausible length.
      encoding: "buffer",
    });
    return new Uint8Array(stdout as Buffer);
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
  async function ffmpegToFile(args: (out: string) => string[], suffix: string): Promise<Uint8Array> {
    const out = join(await mkdtemp(join(tmpdir(), "photos-video-")), `out${suffix}`);
    try {
      await run(ffmpeg, args(out), { timeout, maxBuffer: 1024 * 1024, encoding: "buffer" });
      return new Uint8Array(await readFile(out));
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

    async extractPoster(path: string, opts: PosterOptions): Promise<Uint8Array> {
      const facts = await this.probe(path);
      return ffmpegToStdout([
        // -ss before -i seeks by keyframe without decoding everything up to
        // that point. On a long clip the difference is seconds versus minutes.
        "-ss", String(opts.atSeconds),
        "-i", path,
        "-frames:v", "1",
        // Apply the display matrix. Without it a portrait source yields a
        // sideways poster, since ffmpeg works in encoded orientation.
        "-vf", `${transposeFilter(facts.rotation)}${scaleFilter(opts.maxLongEdge, facts.height > facts.width)}`,
        "-f", "image2",
        "-c:v", "mjpeg",
        "-q:v", "3",
        "pipe:1",
      ]);
    },

    async transcode(path: string, opts: TranscodeOptions): Promise<Uint8Array> {
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

    async skim(path: string, opts: SkimOptions): Promise<Uint8Array> {
      const facts = await this.probe(path);
      return ffmpegToFile(
        (out) => [
          "-y",
          "-i", path,
          "-vf",
          [
            transposeFilter(facts.rotation).replace(/,$/, "") || null,
            // setpts before fps: speed up the timeline first, then sample it.
            // Reversed, the sampling happens at source speed and the result is
            // a slideshow of the opening seconds rather than the whole clip.
            `setpts=PTS/${opts.speedFactor}`,
            `fps=${opts.fps}`,
            scaleFilter(opts.maxLongEdge, facts.height > facts.width),
          ]
            .filter(Boolean)
            .join(","),
          // No audio track at all. A skim plays at 10x with no sound; muxing a
          // silent track would cost bytes for nothing.
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
