/**
 * The sweep follows each original's target: the canonical size stamped on it,
 * the standard sizes below it, and a canonical stand-in made for another
 * threshold.
 */
import { describe, expect, it } from "vitest";
import {
  missingClasses,
  replacesFromCanonicalHere,
  sweepWork,
  type SweepRecord,
} from "../src/derivation/sweep-set";
import { withStandInCandidates, type WireStandInSummary } from "../src/photos-lib/stand-in-candidates";

function record(summary: Partial<WireStandInSummary>): SweepRecord {
  return withStandInCandidates({
    id: "R",
    type: "image/jpeg",
    mime_type: "image/jpeg",
    original_filename: "r.jpg",
    size_bytes: 8_000_000,
    fidelity: 6000,
    metadata: { width: 6000, height: 4000, thumb_hash: "x" },
    stand_ins: {
      category: "image",
      fidelity: 6000,
      status: "archivable",
      top: 4272,
      sizes: [],
      ...summary,
    } as WireStandInSummary,
  });
}

const here = (fidelity: number, role: "smaller" | "canonical") => ({
  fidelity,
  role,
  record_id: `${role}-${fidelity}`,
  type: "image/avif",
  size_bytes: 1000,
  placement: "here" as const,
  url: "http://local/file",
});

describe("the sweep and each original's target", () => {
  it("counts an outdated canonical stand-in as missing at the new size", () => {
    const r = record({
      canonical_target: 2560,
      canonical_outdated: true,
      sizes: [here(320, "smaller"), here(640, "smaller"), here(1280, "smaller"), here(4272, "canonical")],
    });
    expect(missingClasses(r)).toEqual(["image-large"]);
    expect(replacesFromCanonicalHere(r)).toBe(true);
  });

  it("finds nothing missing once the canonical stand-in matches", () => {
    const r = record({
      canonical_target: 4272,
      canonical_outdated: false,
      sizes: [here(320, "smaller"), here(640, "smaller"), here(1280, "smaller"), here(2560, "smaller"), here(4272, "canonical")],
    });
    expect(missingClasses(r)).toEqual([]);
  });

  it("does not replace from the canonical stand-in on a raise, which needs the original", () => {
    const r = record({
      canonical_target: 5120,
      canonical_outdated: true,
      sizes: [here(320, "smaller"), here(640, "smaller"), here(1280, "smaller"), here(2560, "smaller"), here(4272, "canonical")],
    });
    expect(missingClasses(r)).toEqual(["image-large"]);
    expect(replacesFromCanonicalHere(r)).toBe(false);
  });

  it("takes a lowered replacement with downloads off when the canonical stand-in is here", () => {
    const r = record({
      canonical_target: 2560,
      canonical_outdated: true,
      original_placement: "cloud",
      sizes: [here(320, "smaller"), here(640, "smaller"), here(1280, "smaller"), here(4272, "canonical")],
    });
    const switches = { derivePhotoStandIns: true, deriveVideoStandIns: false, mayDownload: false };
    expect(sweepWork([r], "full", switches, ["image-xsmall", "image-thumb"])).toEqual([r]);
  });
});
