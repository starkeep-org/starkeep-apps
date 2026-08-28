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
  transcodeWouldChangeAnything,
  skimDurationSeconds,
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

describe("Rule 2 — generate when the original exceeds the next lower maximum", () => {
  // The bottom rung is unconditional, so every record has an instantly readable
  // copy and the grid needs no fallback path.
  it("always generates the bottom rung, however small the original", () => {
    for (const original of [1, 10, 399, 400, 100_000]) {
      expect(classesFor(original)[0]).toBe(STILL_LADDER[0]!.sizeClass);
    }
  });

  it("adds a class exactly when the original passes the class below it", () => {
    for (let i = 1; i < STILL_LADDER.length; i++) {
      const below = STILL_LADDER[i - 1]!;
      const spec = STILL_LADDER[i]!;
      // No offset, no margin: at the boundary the class is not generated, one
      // pixel past it, it is.
      expect(classesFor(below.maxLongEdge)).not.toContain(spec.sizeClass);
      expect(classesFor(below.maxLongEdge + 1)).toContain(spec.sizeClass);
    }
  });

  // The property the rest of the system reads "top applicable class" off. Both
  // the ladder-complete gate and the derivation sweeper rely on it, and neither
  // would be expressible if the set could have holes.
  it("produces a contiguous prefix from the bottom, never a gap", () => {
    // Boundaries read off the ladder rather than written out, so a rung added
    // or respecified is exercised at its own edges without editing this list.
    const boundaries = STILL_LADDER.flatMap((s) => [s.maxLongEdge, s.maxLongEdge + 1]);
    for (const original of [1, ...boundaries, 50_000]) {
      const got = classesFor(original);
      const expectedPrefix = STILL_LADDER.slice(0, got.length).map((s) => s.sizeClass);
      expect(got, `original=${original}`).toEqual(expectedPrefix);
    }
  });

  it("generates the whole ladder for a large enough original", () => {
    const huge = STILL_LADDER[STILL_LADDER.length - 1]!.maxLongEdge + 1;
    expect(classesFor(huge)).toEqual(STILL_LADDER.map((s) => s.sizeClass));
  });

  it("reports the top applicable class, which describes the whole set", () => {
    for (const original of [1, 401, 1281, 2561, 99_999]) {
      const all = applicableStillClasses(original);
      expect(topApplicableStillClass(original)).toBe(all[all.length - 1]);
    }
  });
});

describe("an original at or below the bottom rung", () => {
  // The floor on archiving, stated as the property rather than as a predicate:
  // freezing such an original saves nothing, because the thing that would be
  // read instead is the same size.
  it("means every generated class is the same size as the original", () => {
    const small = STILL_LADDER[0]!.maxLongEdge - 50;
    for (const spec of applicableStillClasses(small)) {
      expect(renditionLongEdge(spec, small)).toBe(small);
    }
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

describe("video — bitrate is a second maximum", () => {
  it("transcodes when resolution drops even if bitrate is already low", () => {
    const spec = VIDEO_LADDER.find((v) => v.sizeClass === "video-720p")!;
    expect(
      transcodeWouldChangeAnything(spec, source({ longEdge: 1920, bitrate: 500_000 })),
    ).toBe(true);
  });

  it("transcodes when bitrate drops even if resolution is already low", () => {
    const spec = VIDEO_LADDER.find((v) => v.sizeClass === "video-720p")!;
    expect(
      transcodeWouldChangeAnything(spec, source({ longEdge: 640, bitrate: 20_000_000 })),
    ).toBe(true);
  });

  // The no-op clause. Re-encoding a 480p 800 kbps clip into "720p" produces a
  // file that is no better, probably larger, and definitely lossier — such a
  // clip is its own video-720p.
  it("does not transcode when neither axis would change", () => {
    const spec = VIDEO_LADDER.find((v) => v.sizeClass === "video-720p")!;
    expect(
      transcodeWouldChangeAnything(spec, source({ longEdge: 640, bitrate: 800_000 })),
    ).toBe(false);
    expect(videoClassesFor(source({ longEdge: 640, bitrate: 800_000 }))).not.toContain(
      "video-720p",
    );
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

describe("video — optional classes", () => {
  it("leaves 1080p out unless the library opts in", () => {
    expect(DEFAULT_DISABLED_CLASSES).toContain("video-1080p");
    const big = source({ longEdge: 3840, bitrate: 40_000_000 });
    expect(videoClassesFor(big)).not.toContain("video-1080p");
    expect(videoClassesFor(big, ["video-1080p"])).toContain("video-1080p");
  });

  it("still honours the maxima once enabled", () => {
    // A 720p source has nothing to gain from a 1080p rung.
    const small = source({ longEdge: 1280, bitrate: 1_000_000 });
    expect(videoClassesFor(small, ["video-1080p"])).not.toContain("video-1080p");
  });
});
