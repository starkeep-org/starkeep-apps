/**
 * The rendition ladder.
 *
 * **No test here asserts a class maximum as a literal.** Those integers are the
 * output of a visual test that has not run yet, and a test asserting `1280`
 * would have to be edited by the same change that makes it wrong — which is
 * exactly when nobody is thinking about whether it *should* be. Everything below
 * asserts a relationship, or reads the number from the ladder itself.
 */
import { describe, it, expect } from "vitest";
import {
  STILL_LADDER,
  VIDEO_LADDER,
  DEFAULT_DISABLED_CLASSES,
  applicableStillClasses,
  applicableVideoClasses,
  renditionLongEdge,
  topApplicableStillClass,
  skimDurationSeconds,
  stillTakesCanonical,
  stillTopLongEdge,
  standInFieldsFor,
  classForStandIn,
  transcodeLongEdge,
  ARCHIVE_SIZE_FLOOR_BYTES,
  IMAGE_CANONICAL_THRESHOLD,
  STAND_IN_MIN_QUALITY,
  VIDEO_CANONICAL_THRESHOLD,
  VIDEO_SMALLER_KBPS,
  transcodeKbps,
  videoFidelityKbps,
  VIDEO_STAND_IN_CRF,
  SKIM_SEGMENT_SECONDS,
  SKIM_INTERVAL_SECONDS,
  type VideoSource,
} from "../src/ladder";

const classesFor = (longEdge: number) =>
  applicableStillClasses(longEdge).map((s) => s.sizeClass);

describe("still ladder shape", () => {
  it("ascends strictly, so 'the next lower class' is well defined", () => {
    for (let i = 1; i < STILL_LADDER.length; i++) {
      expect(STILL_LADDER[i]!.maxLongEdge).toBeGreaterThan(STILL_LADDER[i - 1]!.maxLongEdge);
    }
  });

  it("names each class exactly once", () => {
    const names = STILL_LADDER.map((s) => s.sizeClass);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("Rule 1 — a class never upscales", () => {
  // This is why a class name tells you nothing about a file's actual size, and
  // therefore why resolution has to happen server-side against real dimensions.
  it("emits min(original, class maximum) for every class and every source", () => {
    for (const spec of STILL_LADDER) {
      for (const original of [1, 100, spec.maxLongEdge - 1, spec.maxLongEdge, 99_999]) {
        const emitted = renditionLongEdge(spec, original);
        expect(emitted).toBeLessThanOrEqual(original);
        expect(emitted).toBeLessThanOrEqual(spec.maxLongEdge);
      }
    }
  });

  it("never emits a file larger than its source", () => {
    const tiny = 120;
    for (const spec of applicableStillClasses(tiny)) {
      expect(renditionLongEdge(spec, tiny)).toBe(tiny);
    }
  });
});

describe("stand-ins — a rung only below the original, the canonical rung only when it archives", () => {
  const CANONICAL = STILL_LADDER.find((s) => s.role === "canonical")!;
  const SMALLER = STILL_LADDER.filter((s) => s.role === "smaller");
  const BIG_FILE = ARCHIVE_SIZE_FLOOR_BYTES * 8;

  it("makes the top rung the canonical stand-in, at the platform's threshold", () => {
    expect(STILL_LADDER[STILL_LADDER.length - 1]).toBe(CANONICAL);
    expect(CANONICAL.maxLongEdge).toBe(IMAGE_CANONICAL_THRESHOLD);
  });

  it("encodes every rung at the platform's minimum quality", () => {
    for (const spec of STILL_LADDER) expect(spec.quality, spec.sizeClass).toBe(STAND_IN_MIN_QUALITY);
  });

  it("takes a smaller rung exactly when the original is larger, with no clamping", () => {
    for (const spec of SMALLER) {
      expect(classesFor(spec.maxLongEdge)).not.toContain(spec.sizeClass);
      expect(classesFor(spec.maxLongEdge + 1)).toContain(spec.sizeClass);
    }
  });

  it("takes nothing for an original at or below the bottom rung, which serves itself", () => {
    expect(classesFor(STILL_LADDER[0]!.maxLongEdge)).toEqual([]);
    expect(topApplicableStillClass(STILL_LADDER[0]!.maxLongEdge)).toBeNull();
  });

  it("takes the canonical rung only above the threshold and past the size floor", () => {
    expect(classesFor(CANONICAL.maxLongEdge)).not.toContain(CANONICAL.sizeClass);
    expect(classesFor(CANONICAL.maxLongEdge + 1)).toContain(CANONICAL.sizeClass);
    expect(
      applicableStillClasses(CANONICAL.maxLongEdge + 1, ARCHIVE_SIZE_FLOOR_BYTES).map((s) => s.sizeClass),
    ).not.toContain(CANONICAL.sizeClass);
    expect(stillTakesCanonical(CANONICAL.maxLongEdge + 1, BIG_FILE)).toBe(true);
  });

  it("answers large requests with the canonical stand-in, or the original itself", () => {
    expect(stillTopLongEdge(9000, BIG_FILE)).toBe(IMAGE_CANONICAL_THRESHOLD);
    expect(stillTopLongEdge(3000, BIG_FILE)).toBe(3000);
    expect(stillTopLongEdge(9000, 1000)).toBe(9000);
  });

  it("produces a contiguous prefix from the bottom, never a gap", () => {
    const boundaries = STILL_LADDER.flatMap((s) => [s.maxLongEdge, s.maxLongEdge + 1]);
    for (const original of [1, ...boundaries, 50_000]) {
      const got = classesFor(original);
      const expectedPrefix = STILL_LADDER.slice(0, got.length).map((s) => s.sizeClass);
      expect(got, `original=${original}`).toEqual(expectedPrefix);
    }
  });

  it("generates the whole ladder for a large enough original", () => {
    const huge = CANONICAL.maxLongEdge + 1;
    expect(classesFor(huge)).toEqual(STILL_LADDER.map((s) => s.sizeClass));
  });

  it("reports the top applicable class, which describes the whole set", () => {
    for (const original of [401, 1281, 2561, 99_999]) {
      const all = applicableStillClasses(original);
      expect(topApplicableStillClass(original)).toBe(all[all.length - 1]);
    }
  });

  it("describes each rung to the platform as a role and a fidelity, and reads one back", () => {
    for (const spec of STILL_LADDER) {
      const fields = standInFieldsFor(spec.sizeClass, 99_999)!;
      expect(fields).toEqual({ role: spec.role, fidelity: spec.maxLongEdge });
      expect(classForStandIn("image", fields.role, fields.fidelity)).toBe(spec.sizeClass);
    }
    expect(classForStandIn("image", "smaller", 500)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const source = (over: Partial<VideoSource> = {}): VideoSource => ({
  longEdge: 1920,
  bitrate: 8_000_000,
  durationSeconds: 60,
  ...over,
});

const videoClassesFor = (s: VideoSource, enabled: string[] = []) =>
  applicableVideoClasses(s, enabled as never).map((v) => v.sizeClass);

describe("video — transcodes are stand-ins", () => {
  const canonical = VIDEO_LADDER.find((v) => v.role === "canonical")!;
  const smaller = VIDEO_LADDER.find((v) => v.kind === "transcode" && v.role === "smaller")!;

  it("gives every video a canonical stand-in, even one that needs no smaller size", () => {
    for (const longEdge of [320, 640, 1280, 1920, 3840]) {
      expect(videoClassesFor(source({ longEdge, bitrate: 300_000 })), `${longEdge}`).toContain(
        canonical.sizeClass,
      );
    }
  });

  it("never encodes above the source's own long edge", () => {
    expect(transcodeLongEdge(canonical, { longEdge: 1280 })).toBe(1280);
    expect(transcodeLongEdge(canonical, { longEdge: 3840 })).toBe(canonical.maxLongEdge);
    expect(transcodeLongEdge(smaller, { longEdge: 480 })).toBe(480);
    expect(transcodeLongEdge(smaller, { longEdge: 3840 })).toBe(smaller.maxLongEdge);
  });

  it("puts the canonical stand-in at the video's own bitrate up to the threshold", () => {
    expect(transcodeKbps(canonical, 3000)).toBe(3000);
    expect(transcodeKbps(canonical, 12_000)).toBe(VIDEO_CANONICAL_THRESHOLD);
    expect(standInFieldsFor(canonical.sizeClass, 3000)).toEqual({ role: "canonical", fidelity: 3000 });
    expect(standInFieldsFor(canonical.sizeClass, 12_000)).toEqual({
      role: "canonical",
      fidelity: VIDEO_CANONICAL_THRESHOLD,
    });
  });

  it("puts the smaller stand-in at its standard bitrate", () => {
    expect(transcodeKbps(smaller, 12_000)).toBe(VIDEO_SMALLER_KBPS);
    expect(standInFieldsFor(smaller.sizeClass, 12_000)).toEqual({ role: "smaller", fidelity: VIDEO_SMALLER_KBPS });
  });

  it("takes the smaller transcode only below the source's bitrate, whatever its resolution", () => {
    const at = VIDEO_SMALLER_KBPS * 1000;
    expect(videoClassesFor(source({ bitrate: at }))).not.toContain(smaller.sizeClass);
    // Rounds to the smaller size's own fidelity, which the platform refuses.
    expect(videoClassesFor(source({ bitrate: at + 400 }))).not.toContain(smaller.sizeClass);
    expect(videoClassesFor(source({ bitrate: at + 1000 }))).toContain(smaller.sizeClass);
    expect(videoClassesFor(source({ longEdge: 480, bitrate: 6_000_000 }))).toContain(smaller.sizeClass);
    expect(videoClassesFor(source({ bitrate: Number.POSITIVE_INFINITY }))).toContain(smaller.sizeClass);
  });

  it("measures a video's fidelity in whole kbps", () => {
    expect(videoFidelityKbps({ bitrate: 4_782_400 })).toBe(4782);
    expect(videoFidelityKbps({ bitrate: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("encodes at the platform's CRF, capped by a target bitrate", () => {
    expect(VIDEO_STAND_IN_CRF).toBe(31);
    for (const spec of VIDEO_LADDER.filter((v) => v.kind === "transcode")) {
      expect(spec.targetKbps, spec.sizeClass).toBeGreaterThan(0);
    }
  });

  it("reads a video stand-in back to its rung", () => {
    expect(classForStandIn("video", "canonical", 3000)).toBe(canonical.sizeClass);
    expect(classForStandIn("video", "smaller", VIDEO_SMALLER_KBPS)).toBe(smaller.sizeClass);
    expect(classForStandIn("video", "smaller", 1280)).toBeNull();
  });

  it("describes posters and skims as derived records, not stand-ins", () => {
    for (const spec of VIDEO_LADDER.filter((v) => v.kind !== "transcode")) {
      expect(standInFieldsFor(spec.sizeClass, 1920)).toBeNull();
    }
  });
});

describe("video — skim is exempt from the no-op clause", () => {
  // It differs from its source in the *time* dimension: a 15-second clip has no
  // smaller resolution worth making but still benefits from a 2-second scrub.
  it("is generated even for a clip that needs no other transcode", () => {
    expect(videoClassesFor(source({ longEdge: 320, bitrate: 300_000 }))).toContain(
      "video-skim",
    );
  });

  // One segment per interval, at source speed — so the output is a fixed
  // fraction of the source rather than a fixed length. Asserted as a ratio
  // rather than as seconds, because the cadence is provisional.
  it("keeps one segment out of every interval", () => {
    const ratio = SKIM_SEGMENT_SECONDS / SKIM_INTERVAL_SECONDS;
    for (const duration of [SKIM_INTERVAL_SECONDS, 60, 600, 3600]) {
      expect(skimDurationSeconds(duration), `${duration}s`).toBeCloseTo(duration * ratio, 5);
    }
  });

  it("samples across the whole clip, so length grows with the source", () => {
    // The property the previous shape did not have: it capped output length,
    // which meant a long clip was skimmed no more thoroughly than a short one.
    expect(skimDurationSeconds(600)).toBeGreaterThan(skimDurationSeconds(60));
  });

  it("never produces a skim longer than its source", () => {
    for (const duration of [0, 0.4, 1, 5, 10, 160, 3600]) {
      expect(skimDurationSeconds(duration), `${duration}s`).toBeLessThanOrEqual(duration);
    }
  });

  it("gives a clip shorter than one interval a single partial segment", () => {
    // A 3-second clip is 3 seconds of one window, so it skims to one segment;
    // a clip shorter than a segment skims to itself.
    expect(skimDurationSeconds(SKIM_INTERVAL_SECONDS - 1)).toBe(SKIM_SEGMENT_SECONDS);
    expect(skimDurationSeconds(SKIM_SEGMENT_SECONDS / 2)).toBe(SKIM_SEGMENT_SECONDS / 2);
  });
});

describe("video — posters", () => {
  it("always generates the smallest poster, so a grid tile always exists", () => {
    expect(videoClassesFor(source({ longEdge: 120 }))).toContain("video-poster-thumb");
  });

  // Pinned to video-720p's maximum rather than chosen independently: a poster
  // sharper than the footage it hands off to degrades visibly at the moment
  // playback starts.
  it("pins the larger poster's maximum to the inline playback class", () => {
    const poster = VIDEO_LADDER.find((v) => v.sizeClass === "video-poster-720p")!;
    const playback = VIDEO_LADDER.find((v) => v.sizeClass === "video-720p")!;
    expect(poster.maxLongEdge).toBe(playback.maxLongEdge);
  });
});

describe("video — no optional classes", () => {
  it("disables nothing by default: the canonical transcode is what lets a video archive", () => {
    expect(DEFAULT_DISABLED_CLASSES).toEqual([]);
  });
});
