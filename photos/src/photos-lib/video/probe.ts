/**
 * Reading a video container's facts (item 26).
 *
 * Split deliberately into a pure parser over ffprobe's JSON and a thin runner
 * that produces that JSON. The interesting mistakes are all in the
 * interpretation — rotation, frame-rate fractions, missing streams — and none
 * of them need a subprocess to test.
 *
 * ## Rotation is the trap
 *
 * A phone shoots portrait video by recording a landscape frame and attaching a
 * rotation to the display matrix. ffprobe reports the *encoded* `width` and
 * `height`, so a portrait clip probes as 1920x1080 and is only 1080x1920 once
 * the matrix is applied. Storing the encoded pair means every portrait video in
 * the library lays out sideways in the grid and gets a poster with the wrong
 * aspect ratio — and because the numbers are individually plausible, nothing
 * looks broken until a human sees the grid.
 */

/** What the container says, after rotation has been applied. */
export interface VideoFacts {
  /** Display width — already swapped when the display matrix rotates by a quarter turn. */
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  /** Frames per second, or `null` when the container does not say. */
  readonly frameRate: number | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  /** Whole-container bitrate in bits per second, or `null`. */
  readonly bitrate: number | null;
  /** When the camera says it was shot, ISO-8601, or `null`. */
  readonly capturedAt: string | null;
  /**
   * Quarter-turns the display matrix applies, normalised to 0/90/180/270.
   *
   * Kept after being applied to width/height because deriving a rendition has
   * to know: ffmpeg re-encodes to the *encoded* orientation unless told
   * otherwise, so a transcode that ignores this produces a sideways video from
   * a correctly-tagged source.
   */
  readonly rotation: 0 | 90 | 180 | 270;
}

/** The subset of ffprobe's output this reads. Everything else is ignored. */
interface ProbeJson {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    duration?: string;
    tags?: Record<string, string>;
    side_data_list?: Array<{ rotation?: number }>;
  }>;
  format?: {
    duration?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
}

/**
 * Normalise any rotation the container reports to 0/90/180/270.
 *
 * iPhones commonly write -90 where other cameras write 270; both mean the same
 * quarter turn, and a comparison against a literal 90 would treat one of them
 * as unrotated. The modulo runs twice because JavaScript's `%` keeps the sign
 * of the dividend, so `-90 % 360` is `-90` rather than `270`.
 */
export function normalizeRotation(raw: number | undefined | null): 0 | 90 | 180 | 270 {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  const quarter = Math.round(raw / 90) * 90;
  const normalized = ((quarter % 360) + 360) % 360;
  return (normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0) as
    | 0
    | 90
    | 180
    | 270;
}

/**
 * ffprobe reports frame rate as a fraction string like `30000/1001`, which is
 * 29.97 — the real rate for NTSC-derived footage. Parsing it as a float would
 * read the whole string as NaN.
 */
export function parseFrameRate(raw: string | undefined): number | null {
  if (!raw) return null;
  const [num, den] = raw.split("/");
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  // `0/0` is ffprobe's way of saying "unknown", and dividing it would yield NaN
  // — which would then be written into the database as a real-looking value.
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n === 0) return null;
  return n / d;
}

/**
 * Interpret ffprobe's JSON.
 *
 * Returns `null` when there is no video stream at all — an audio-only file with
 * a `.mp4` extension, or something that is not media. That is a real thing to
 * find in a camera-roll export, and it is not an error worth retrying.
 */
export function parseProbeOutput(json: unknown): VideoFacts | null {
  const probe = json as ProbeJson;
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  if (!video || !video.width || !video.height) return null;

  const audio = streams.find((s) => s.codec_type === "audio");
  const rotation = normalizeRotation(
    video.side_data_list?.find((s) => typeof s.rotation === "number")?.rotation,
  );

  // A quarter turn swaps the axes; a half turn does not. Getting this backwards
  // is invisible in the numbers and obvious in the grid.
  const swap = rotation === 90 || rotation === 270;
  const width = swap ? video.height : video.width;
  const height = swap ? video.width : video.height;

  // Container duration first: a stream's own duration can be missing or, in a
  // variable-frame-rate recording, disagree with the container's.
  const durationSeconds = Number(probe.format?.duration ?? video.duration ?? 0);

  return {
    width,
    height,
    durationMs: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : 0,
    frameRate: parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate),
    videoCodec: video.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    bitrate: numberOrNull(probe.format?.bit_rate),
    capturedAt: captureTime(probe),
    rotation,
  };
}

function numberOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * When the camera says it was shot.
 *
 * QuickTime writes `com.apple.quicktime.creationdate` with a real UTC offset;
 * the generic `creation_time` is what every muxer writes and is frequently the
 * *encode* time rather than the capture time. Preferring the Apple tag matters
 * because a re-muxed clip carries a `creation_time` of whenever it was
 * re-muxed, which would sort a decade-old holiday video into last Tuesday.
 */
function captureTime(probe: ProbeJson): string | null {
  const tags = probe.format?.tags ?? {};
  const raw =
    tags["com.apple.quicktime.creationdate"] ??
    tags["creation_time"] ??
    probe.streams?.find((s) => s.codec_type === "video")?.tags?.["creation_time"];
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Long edge in display orientation — what the ladder's maxima compare against. */
export function displayLongEdge(facts: VideoFacts): number {
  return Math.max(facts.width, facts.height);
}
