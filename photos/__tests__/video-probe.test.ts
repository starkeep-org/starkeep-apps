/**
 * Reading a video container's facts.
 *
 * The parser is tested against ffprobe's real output shape (captured from
 * ffprobe 8.1) rather than an invented one, because the whole risk here is
 * misreading a field that *is* present rather than handling one that is not.
 *
 * Rotation is the case that matters. A phone shoots portrait by recording a
 * landscape frame plus a display matrix, so a portrait clip probes as
 * 1920x1080. Both numbers are individually plausible, nothing throws, and the
 * only symptom is that every portrait video in the library lays out sideways.
 */
import { describe, it, expect } from "vitest";
import {
  parseProbeOutput,
  parseFrameRate,
  normalizeRotation,
  displayLongEdge,
} from "../src/photos-lib/video/probe";

/** Shaped exactly like ffprobe -show_format -show_streams output. */
const probeJson = (over: Record<string, unknown> = {}) => ({
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      width: 1920,
      height: 1080,
      avg_frame_rate: "30/1",
      r_frame_rate: "30/1",
      ...over,
    },
    { codec_type: "audio", codec_name: "aac" },
  ],
  format: {
    duration: "12.500000",
    bit_rate: "8000000",
    tags: { creation_time: "2026-03-04T10:00:00.000000Z" } as Record<string, string>,
  },
});

describe("reading container facts", () => {
  it("reads dimensions, duration, codecs and bitrate", () => {
    const facts = parseProbeOutput(probeJson())!;
    expect(facts).toMatchObject({
      width: 1920,
      height: 1080,
      durationMs: 12_500,
      frameRate: 30,
      videoCodec: "h264",
      audioCodec: "aac",
      bitrate: 8_000_000,
    });
  });

  it("reports no facts for a file with no video stream", () => {
    // An audio-only file with a video extension is a real thing to find in a
    // camera-roll export. Not an error, and not worth retrying forever.
    expect(parseProbeOutput({ streams: [{ codec_type: "audio", codec_name: "aac" }] })).toBeNull();
    expect(parseProbeOutput({})).toBeNull();
  });

  it("survives a video stream with no dimensions rather than inventing them", () => {
    expect(parseProbeOutput({ streams: [{ codec_type: "video", codec_name: "h264" }] })).toBeNull();
  });
});

describe("rotation", () => {
  // The trap. Encoded 1920x1080 + a quarter turn is a 1080x1920 portrait video.
  it("swaps the axes for a quarter turn", () => {
    const facts = parseProbeOutput(
      probeJson({ side_data_list: [{ side_data_type: "Display Matrix", rotation: 90 }] }),
    )!;
    expect(facts.width).toBe(1080);
    expect(facts.height).toBe(1920);
    expect(facts.rotation).toBe(90);
  });

  it("does not swap for a half turn", () => {
    const facts = parseProbeOutput(probeJson({ side_data_list: [{ rotation: 180 }] }))!;
    expect(facts.width).toBe(1920);
    expect(facts.height).toBe(1080);
  });

  // iPhones write -90 where other cameras write 270. Compared against a literal
  // 90 one of them reads as unrotated, and half the library lies on its side.
  it("treats -90 and 270 as the same quarter turn", () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(270)).toBe(270);
    const facts = parseProbeOutput(probeJson({ side_data_list: [{ rotation: -90 }] }))!;
    expect(facts.width).toBe(1080);
  });

  it("normalises angles outside one turn and ignores nonsense", () => {
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-450)).toBe(270);
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(undefined)).toBe(0);
    expect(normalizeRotation(NaN)).toBe(0);
  });

  it("keeps the rotation after applying it, because a transcode still needs it", () => {
    // ffmpeg decodes in encoded orientation and drops the matrix on re-encode,
    // so a transcode that does not know the rotation produces sideways footage
    // from a correctly-tagged source.
    expect(parseProbeOutput(probeJson({ side_data_list: [{ rotation: 90 }] }))!.rotation).toBe(90);
  });

  it("measures the long edge in display orientation", () => {
    const portrait = parseProbeOutput(probeJson({ side_data_list: [{ rotation: 90 }] }))!;
    // Same either way here, which is the point: the long edge is orientation
    // independent, so a bug in the swap would not show up in this number alone.
    expect(displayLongEdge(portrait)).toBe(1920);
  });
});

describe("frame rate", () => {
  // 30000/1001 is 29.97 — the real rate for anything NTSC-derived. Parsed as a
  // float the whole string is NaN, which then gets written to the database.
  it("reads a fractional rate", () => {
    expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseFrameRate("30/1")).toBe(30);
    expect(parseFrameRate("25")).toBe(25);
  });

  it("reports unknown rather than NaN or infinity", () => {
    // `0/0` is ffprobe's way of saying it does not know. Dividing it yields NaN,
    // which is worse than null because it looks like a value.
    expect(parseFrameRate("0/0")).toBeNull();
    expect(parseFrameRate("30/0")).toBeNull();
    expect(parseFrameRate(undefined)).toBeNull();
    expect(parseFrameRate("")).toBeNull();
  });

  it("falls back to r_frame_rate when avg is unknown", () => {
    const facts = parseProbeOutput(probeJson({ avg_frame_rate: "0/0", r_frame_rate: "24/1" }))!;
    expect(facts.frameRate).toBe(24);
  });
});

describe("capture time", () => {
  it("reads the container's creation time", () => {
    expect(parseProbeOutput(probeJson())!.capturedAt).toBe("2026-03-04T10:00:00.000Z");
  });

  // The generic creation_time is what every muxer writes, and on a re-muxed
  // clip it is the *re-mux* time — which would sort a decade-old holiday video
  // into last Tuesday.
  it("prefers the QuickTime capture date over the muxer's creation time", () => {
    const json = probeJson();
    json.format.tags = {
      creation_time: "2026-07-01T00:00:00.000000Z",
      "com.apple.quicktime.creationdate": "2016-08-20T14:30:00+0100",
    } as Record<string, string>;
    expect(parseProbeOutput(json)!.capturedAt).toBe("2016-08-20T13:30:00.000Z");
  });

  it("reports null for an unparseable date rather than an invalid one", () => {
    const json = probeJson();
    json.format.tags = { creation_time: "not a date" };
    expect(parseProbeOutput(json)!.capturedAt).toBeNull();
  });
});
