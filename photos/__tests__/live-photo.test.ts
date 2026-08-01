/**
 * Live Photo pairing.
 *
 * The risk here is asymmetric and worth stating. A missed pair costs a motion
 * clip showing as a separate item in the grid — untidy, recoverable, obvious.
 * A **wrong** pair demotes a real photo or a real video to a component of
 * something else, where the user will never look for it. So the tests below
 * lean hard on the cases that should *not* pair.
 */
import { describe, it, expect } from "vitest";
import {
  findLivePhotoPairs,
  pairConfidence,
  toCandidate,
  MAX_MOTION_DURATION_MS,
} from "../src/photos-lib/import/live-photo";

const still = (path: string, id?: string) =>
  toCandidate(path, { contentIdentifier: id ?? null });
const motion = (path: string, id?: string, durationMs = 3_000) =>
  toCandidate(path, { contentIdentifier: id ?? null, durationMs });

describe("pairing two files", () => {
  // Apple writes the same UUID into both halves precisely so they can be
  // rejoined. When it is there, nothing else matters.
  it("believes a shared content identifier over anything else", () => {
    const s = still("/p/A.heic", "UUID-1");
    const m = motion("/other/COMPLETELY_DIFFERENT.mov", "UUID-1");
    expect(pairConfidence(s, m)).toBe("identifier");
  });

  // A mismatch is positive evidence *against* a pair. Falling through to the
  // filename heuristic here would override the file's own answer with a guess.
  it("refuses a pair when both state identities that disagree", () => {
    const s = still("/p/IMG_1.heic", "UUID-1");
    const m = motion("/p/IMG_1.mov", "UUID-2");
    expect(pairConfidence(s, m)).toBe("none");
  });

  it("falls back to matching stems in the same folder", () => {
    expect(pairConfidence(still("/p/IMG_1.heic"), motion("/p/IMG_1.mov"))).toBe("filename");
  });

  // An export can write IMG_0042.HEIC beside img_0042.mov.
  it("matches stems case-insensitively", () => {
    expect(pairConfidence(still("/p/IMG_1.HEIC"), motion("/p/img_1.mov"))).toBe("filename");
  });

  it("does not pair files in different folders on filename alone", () => {
    expect(pairConfidence(still("/a/IMG_1.heic"), motion("/b/IMG_1.mov"))).toBe("none");
  });

  // The case that matters most: pairing a real video would bury it inside a
  // photo's detail view, where nobody would think to look.
  it("does not treat a long video as a motion clip", () => {
    const long = motion("/p/IMG_1.mov", undefined, MAX_MOTION_DURATION_MS + 1);
    expect(pairConfidence(still("/p/IMG_1.heic"), long)).toBe("none");
  });

  it("accepts a clip at the edge of plausible length", () => {
    const edge = motion("/p/IMG_1.heic".replace(".heic", ".mov"), undefined, MAX_MOTION_DURATION_MS);
    expect(pairConfidence(still("/p/IMG_1.heic"), edge)).toBe("filename");
  });

  it("pairs nothing when the roles are wrong", () => {
    // Two stills, or two clips, are not a Live Photo however they are named.
    expect(pairConfidence(still("/p/A.heic"), still("/p/A.jpg") as never)).toBe("none");
    expect(pairConfidence(motion("/p/A.mov") as never, motion("/p/A.mp4"))).toBe("none");
  });
});

describe("pairing across an import", () => {
  it("finds the pairs and leaves everything else alone", () => {
    const pairs = findLivePhotoPairs([
      still("/p/IMG_1.heic"),
      motion("/p/IMG_1.mov"),
      still("/p/IMG_2.jpg"),
      motion("/p/holiday.mov", undefined, 90_000),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.still.path).toBe("/p/IMG_1.heic");
    expect(pairs[0]!.motion.path).toBe("/p/IMG_1.mov");
  });

  // IMG_0042.HEIC + IMG_0042.jpg + IMG_0042.mov is genuinely ambiguous, and
  // choosing one arbitrarily silently demotes a real photo to a component of
  // another.
  it("leaves an ambiguous stem entirely unpaired", () => {
    const pairs = findLivePhotoPairs([
      still("/p/IMG_1.heic"),
      still("/p/IMG_1.jpg"),
      motion("/p/IMG_1.mov"),
    ]);
    expect(pairs).toEqual([]);
  });

  // A file paired by what the container says must not be re-paired by a
  // filename coincidence.
  it("lets an identifier pair win over a competing filename pair", () => {
    const pairs = findLivePhotoPairs([
      still("/p/IMG_1.heic", "UUID-1"),
      motion("/p/IMG_9.mov", "UUID-1"),
      motion("/p/IMG_1.mov"),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.confidence).toBe("identifier");
    expect(pairs[0]!.motion.path).toBe("/p/IMG_9.mov");
  });

  it("never claims one file in two pairs", () => {
    const pairs = findLivePhotoPairs([
      still("/p/IMG_1.heic", "UUID-1"),
      motion("/p/IMG_1.mov", "UUID-1"),
    ]);
    const paths = pairs.flatMap((p) => [p.still.path, p.motion.path]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("reports nothing for a folder of ordinary photos", () => {
    expect(
      findLivePhotoPairs([still("/p/a.jpg"), still("/p/b.jpg"), still("/p/c.heic")]),
    ).toEqual([]);
  });
});

describe("splitting a path", () => {
  it("separates directory, stem and extension", () => {
    expect(toCandidate("/photos/2026/IMG_0042.HEIC")).toMatchObject({
      directory: "/photos/2026",
      stem: "IMG_0042",
      extension: ".heic",
    });
  });

  it("handles a dotfile-free name with no extension", () => {
    expect(toCandidate("/photos/README")).toMatchObject({ stem: "README", extension: "" });
  });
});
