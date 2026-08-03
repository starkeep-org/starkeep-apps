/**
 * Video derivation against real ffmpeg and real files.
 *
 * The ladder rules and the probe parser are unit-tested elsewhere. What neither
 * can show is whether the arguments this builds actually produce the video they
 * claim to: an ffmpeg filter chain is a string, and a wrong one fails by
 * producing a plausible file with the wrong pixels in it.
 *
 * Skipped when ffmpeg is absent rather than failed — this suite has to be
 * runnable in a container that never installs it. The `available()` path that
 * makes that skip correct is itself asserted below.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFfmpegTools,
  posterTimestamp,
  scaleFilter,
  transposeFilter,
  UnsupportedVideoError,
  type VideoTools,
} from "../src/photos-lib/video/video-tools";
import {
  deriveVideoLadder,
  videoSourceOf,
  missingVideoClasses,
} from "../src/photos-lib/video/derive-video-ladder";
import {
  skimDurationSeconds,
  SKIM_INTERVAL_SECONDS,
} from "../src/photos-lib/ladder";

const run = promisify(execFile);

let dir: string;
/** 640x480 landscape, 3s. */
let landscape: string;
/** The same footage carrying a 90° display matrix — i.e. portrait. */
let rotated: string;

const tools: VideoTools = createFfmpegTools();

/**
 * Resolved at module load, deliberately.
 *
 * `it` versus `it.skip` is decided while the suite is being *collected*, which
 * happens before any `beforeAll` runs — so a flag set in a hook is still false
 * when the choice is made, and every ffmpeg test silently skips. A suite that
 * reports green while testing nothing is worse than one that fails, so this is
 * a top-level await and the guard below asserts the result rather than
 * trusting it.
 */
const hasFfmpeg = await tools.available();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "photos-video-"));
  if (!hasFfmpeg) return;

  landscape = join(dir, "land.mp4");
  rotated = join(dir, "rot.mp4");
  await run("ffmpeg", [
    "-y", "-f", "lavfi",
    "-i", "testsrc=size=640x480:rate=30:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", landscape,
  ]);
  // A real display-matrix rotation, which is how phones record portrait — not
  // the deprecated `rotate` metadata tag, which modern ffmpeg ignores.
  await run("ffmpeg", ["-y", "-display_rotation", "90", "-i", landscape, "-c", "copy", rotated]);
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ffmpeg = () => (hasFfmpeg ? it : it.skip);

describe("test environment", () => {
  // Silent skipping is how a suite like this rots: ffmpeg disappears from an
  // image, every meaningful test skips, and the run still reports green. Set
  // STARKEEP_REQUIRE_FFMPEG=1 wherever the coverage is supposed to be real and
  // the absence becomes a failure instead of a shrug.
  it("has ffmpeg when the environment says it must", () => {
    if (process.env.STARKEEP_REQUIRE_FFMPEG !== "1") return;
    expect(hasFfmpeg, "STARKEEP_REQUIRE_FFMPEG=1 but ffmpeg/ffprobe were not found").toBe(true);
  });
});

/** Read back what ffprobe says about produced bytes. */
async function probeBytes(bytes: Uint8Array, name: string) {
  const path = join(dir, name);
  await writeFile(path, bytes);
  const { stdout } = await run("ffprobe", [
    "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path,
  ]);
  return JSON.parse(stdout) as {
    streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>;
    format: { duration: string };
  };
}

describe("filter construction", () => {
  // Pure string building, so it is worth pinning exactly — these are the
  // arguments every derivation below depends on.
  it("never upscales", () => {
    // `min(iw,N)` rather than a flat N: ffmpeg will happily blow a 480p clip up
    // to 720p, producing a larger file with no more detail.
    expect(scaleFilter(1280, false)).toContain("min(iw,1280)");
    expect(scaleFilter(1280, true)).toContain("min(ih,1280)");
  });

  it("keeps the other axis even, which H.264 requires", () => {
    // An odd dimension is a hard encoder error under yuv420p chroma
    // subsampling, not a rounding warning.
    expect(scaleFilter(1280, false)).toContain("-2");
    expect(scaleFilter(1280, true)).toContain("-2");
  });

  // Pinned as a no-op on purpose. Knowing that a portrait phone clip is encoded
  // landscape plus a rotation, the instinct is to bake it in with `transpose` —
  // and that is wrong, because ffmpeg's autorotate is on by default and has
  // already done it. Transposing again turns a correctly-tagged portrait clip
  // into a landscape rendition of sideways footage. Verified directly:
  // extracting a frame from a 640x480 clip with a 90° matrix gives 480x640 with
  // no filter, and 640x480 under -noautorotate.
  it("does not transpose, because ffmpeg has already applied the display matrix", () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      expect(transposeFilter(rotation), `rotation ${rotation}`).toBe("");
    }
  });
});

describe("choosing the poster frame", () => {
  // Not frame zero: real footage very often opens black (fade-in, exposure
  // ramp), and a grid of uniformly black video tiles looks broken in a way
  // that is entirely self-inflicted.
  it("skips the opening frame", () => {
    expect(posterTimestamp(30)).toBeGreaterThan(0);
  });

  it("does not go deep into a long clip", () => {
    // A poster from a minute in may have nothing to do with what the clip is of.
    expect(posterTimestamp(600)).toBeLessThanOrEqual(1);
  });

  it("stays inside a very short clip", () => {
    expect(posterTimestamp(0.5)).toBeLessThan(0.5);
    expect(posterTimestamp(0)).toBe(0);
  });
});

describe("probing a real file", () => {
  ffmpeg()("reads the facts of a landscape clip", async () => {
    const facts = await tools.probe(landscape);
    expect(facts).toMatchObject({ width: 640, height: 480, videoCodec: "h264", rotation: 0 });
    expect(facts.durationMs).toBeGreaterThan(2_900);
    expect(facts.frameRate).toBeCloseTo(30, 1);
  });

  // The whole reason rotation handling exists: this file is encoded 640x480 and
  // is a 480x640 portrait video.
  ffmpeg()("reports a rotated clip in display orientation", async () => {
    const facts = await tools.probe(rotated);
    expect(facts.width).toBe(480);
    expect(facts.height).toBe(640);
    expect(facts.rotation).toBe(90);
  });

  ffmpeg()("rejects a file that is not video, terminally", async () => {
    const notVideo = join(dir, "notes.mp4");
    await writeFile(notVideo, "this is not a video");
    // Terminal, so the import ledger records it as unsupported and never
    // retries — rather than re-failing on it every sweep.
    await expect(tools.probe(notVideo)).rejects.toBeInstanceOf(UnsupportedVideoError);
  });
});

describe("deriving the ladder", () => {
  ffmpeg()("produces a poster that is a real still image", async () => {
    const result = await deriveVideoLadder(landscape, tools);
    const poster = result.renditions.find((r) => r.sizeClass === "video-poster-thumb")!;
    expect(poster.contentType).toBe("image/jpeg");

    const probed = await probeBytes(poster.bytes, "poster.jpg");
    expect(probed.streams[0]!.codec_name).toBe("mjpeg");
    // Scaled down to the rung's maximum, not left at source size.
    expect(Math.max(probed.streams[0]!.width!, probed.streams[0]!.height!)).toBeLessThanOrEqual(400);
  }, 120_000);

  // The assertion that proves transposeFilter reaches the pixels. Without it
  // the poster comes out 400x300 landscape from a portrait source — a
  // plausible image of sideways footage.
  ffmpeg()("bakes rotation into a poster from a portrait source", async () => {
    const result = await deriveVideoLadder(rotated, tools);
    const poster = result.renditions.find((r) => r.sizeClass === "video-poster-thumb")!;
    const probed = await probeBytes(poster.bytes, "poster-rot.jpg");
    expect(
      probed.streams[0]!.height,
      "a portrait source produced a landscape poster — rotation was not applied",
    ).toBeGreaterThan(probed.streams[0]!.width!);
  }, 120_000);

  ffmpeg()("produces a skim that is shorter than its source and silent", async () => {
    const result = await deriveVideoLadder(landscape, tools);
    const skim = result.renditions.find((r) => r.sizeClass === "video-skim")!;
    const probed = await probeBytes(skim.bytes, "skim.mp4");

    // A 3-second source falls inside one sampling window, so it yields a single
    // segment. Read from the ladder, since the cadence is provisional.
    expect(Number(probed.format.duration)).toBeCloseTo(skimDurationSeconds(3), 1);
    // Audio sampled on the same cadence is a sequence of clicks, and a silent
    // track would cost bytes for nothing.
    expect(probed.streams.some((s) => s.codec_type === "audio")).toBe(false);
  }, 120_000);

  // The assertion that proves `setpts` follows `select`. Without it the dropped
  // frames keep their original timestamps and the output is a full-length clip
  // with a frozen frame between each segment — plausible bytes, ten times the
  // size, and useless as a scrub.
  ffmpeg()("samples across a long clip rather than taking its opening", async () => {
    const long = join(dir, "long.mp4");
    const sourceSeconds = SKIM_INTERVAL_SECONDS * 3;
    await run("ffmpeg", [
      "-y", "-f", "lavfi",
      "-i", `testsrc=size=640x480:rate=30:duration=${sourceSeconds}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", long,
    ]);
    const result = await deriveVideoLadder(long, tools);
    const skim = result.renditions.find((r) => r.sizeClass === "video-skim")!;
    const probed = await probeBytes(skim.bytes, "skim-long.mp4");

    // One segment per window: taking only the opening would give one segment,
    // and failing to renumber timestamps would give the whole source length.
    expect(Number(probed.format.duration)).toBeCloseTo(
      skimDurationSeconds(sourceSeconds),
      1,
    );
    expect(Number(probed.format.duration)).toBeLessThan(sourceSeconds);
  }, 240_000);

  // The transcode path escaped every other test here because a 640x480 fixture
  // hits the no-op clause, so nothing ever asked it to encode. It was broken:
  // `-movflags +faststart` cannot write to a pipe ("muxer does not support non
  // seekable output"), which would have failed every real transcode in the
  // library while the suite stayed green.
  ffmpeg()("actually encodes when the source is above the ceilings", async () => {
    const big = join(dir, "big.mp4");
    await run("ffmpeg", [
      "-y", "-f", "lavfi",
      "-i", "testsrc=size=1920x1080:rate=30:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", big,
    ]);
    const result = await deriveVideoLadder(big, tools);
    const transcode = result.renditions.find((r) => r.sizeClass === "video-720p");
    expect(transcode, `no 720p produced; failures: ${JSON.stringify(result.failures)}`).toBeDefined();

    const probed = await probeBytes(transcode!.bytes, "t.mp4");
    expect(Math.max(probed.streams[0]!.width!, probed.streams[0]!.height!)).toBeLessThanOrEqual(1280);
  }, 240_000);

  // faststart is the whole reason ranged serving buys anything: with the moov
  // atom at the end, a player must fetch the entire file before the first
  // frame, and item 28's Range support saves nothing.
  ffmpeg()("puts the moov atom at the front so playback can start early", async () => {
    const result = await deriveVideoLadder(landscape, tools);
    const skim = result.renditions.find((r) => r.sizeClass === "video-skim")!;
    const head = Buffer.from(skim.bytes.subarray(0, 256)).toString("latin1");
    const moov = head.indexOf("moov");
    const mdat = head.indexOf("mdat");
    expect(moov, "moov atom is not near the front of the file").toBeGreaterThan(-1);
    // Either mdat is not in the first 256 bytes at all, or it follows moov.
    if (mdat >= 0) expect(moov).toBeLessThan(mdat);
  }, 120_000);

  // Variant resolution orders renditions by long edge, so a rendition with no
  // dimensions is invisible to it — storage nobody ever reads. Measured from
  // the output rather than computed from the source, because the scale filter
  // rounds the free axis to an even number and a predicted value is off by one
  // often enough to sort a rendition into the wrong place.
  ffmpeg()("reports dimensions that match the bytes it produced", async () => {
    const result = await deriveVideoLadder(landscape, tools);
    for (const rendition of result.renditions) {
      const probed = await probeBytes(rendition.bytes, `dim-${rendition.sizeClass}.bin`);
      expect(rendition.width, rendition.sizeClass).toBe(probed.streams[0]!.width);
      expect(rendition.height, rendition.sizeClass).toBe(probed.streams[0]!.height);
      expect(rendition.width, `${rendition.sizeClass} has no dimensions`).toBeGreaterThan(0);
    }
  }, 180_000);

  // A poster is genuinely a still and must register as an image: it is what the
  // grid paints, and an image-granted app that could not see it would show a
  // library with holes where the clips are.
  ffmpeg()("registers posters as images and moving renditions as video", async () => {
    const result = await deriveVideoLadder(landscape, tools);
    for (const r of result.renditions) {
      expect(r.type, r.sizeClass).toBe(r.kind === "poster" ? "image" : "video");
    }
  }, 120_000);

  // The no-op clause. A 640x480 source is already below every 720p ceiling, and
  // re-encoding it produces a file that is no better, probably larger, and
  // definitely lossier.
  ffmpeg()("does not transcode a source already below the ceilings", async () => {
    const result = await deriveVideoLadder(landscape, tools);
    expect(result.renditions.map((r) => r.sizeClass)).not.toContain("video-720p");
  }, 120_000);

  ffmpeg()("reports failures per class rather than discarding what succeeded", async () => {
    // A tools implementation whose transcode always fails still has to yield
    // its poster: throwing the poster away because a minutes-long encode failed
    // would leave a hole in the grid for a thumbnail that was sitting right
    // there.
    const flaky: VideoTools = {
      ...tools,
      available: () => Promise.resolve(true),
      probe: (p) => tools.probe(p),
      extractPoster: (p, o) => tools.extractPoster(p, o),
      skim: () => Promise.reject(new Error("encoder fell over")),
      transcode: () => Promise.reject(new Error("encoder fell over")),
    };
    const result = await deriveVideoLadder(landscape, flaky);
    expect(result.renditions.some((r) => r.kind === "poster")).toBe(true);
    expect(result.failures.map((f) => f.sizeClass)).toContain("video-skim");
  }, 120_000);
});

describe("when ffmpeg is not installed", () => {
  const absent = createFfmpegTools({
    ffmpegPath: "/nonexistent/ffmpeg",
    ffprobePath: "/nonexistent/ffprobe",
  });

  it("reports itself unavailable rather than throwing", async () => {
    expect(await absent.available()).toBe(false);
  });

  // Terminal, not transient. Retried every sweep, a missing binary burns the
  // whole run rediscovering that it is still missing.
  it("fails derivation terminally", async () => {
    await expect(deriveVideoLadder("/any/path.mp4", absent)).rejects.toBeInstanceOf(
      UnsupportedVideoError,
    );
  });
});

describe("ladder completeness", () => {
  const facts = {
    width: 3840, height: 2160, durationMs: 60_000, frameRate: 30,
    videoCodec: "hevc", audioCodec: "aac", bitrate: 40_000_000,
    capturedAt: null, rotation: 0 as const,
  };

  it("treats a container with no declared bitrate as unbounded, not as zero", () => {
    // Zero would read as "already below every ceiling" and suppress every
    // transcode — failing in the direction that silently ships no renditions.
    const source = videoSourceOf({ ...facts, bitrate: null });
    expect(source.bitrate).toBe(Number.POSITIVE_INFINITY);
  });

  it("lists what a record still owes", () => {
    const missing = missingVideoClasses(facts, ["video-poster-thumb"]);
    expect(missing).toContain("video-720p");
    expect(missing).not.toContain("video-poster-thumb");
  });

  it("excludes optional classes nobody enabled", () => {
    expect(missingVideoClasses(facts, [])).not.toContain("video-1080p");
    expect(missingVideoClasses(facts, [], ["video-1080p"])).toContain("video-1080p");
  });
});
