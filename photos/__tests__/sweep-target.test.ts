/**
 * The sweep follows each original's target: the canonical size stamped on the
 * original, and the standard sizes below it.
 */
import { describe, expect, it } from "vitest";
import { missingClasses, sweepWork, type SweepRecord } from "../src/derivation/sweep-set";
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
  it("finds nothing missing once every size the target names exists", () => {
    const r = record({
      canonical_target: 4272,
      sizes: [here(320, "smaller"), here(640, "smaller"), here(1280, "smaller"), here(2560, "smaller"), here(4272, "canonical")],
    });
    expect(missingClasses(r)).toEqual([]);
  });

  it("takes only the sizes the target names, and the canonical rung at its stamp", () => {
    // Stamped at 2560, so the canonical rung is 2560 and 4272 is not a size
    // this original takes at all. The summary lists the sizes that apply, so
    // 1280 is not one of them here.
    const r = record({ canonical_target: 2560, top: 2560, sizes: [here(320, "smaller"), here(640, "smaller")] });
    expect(missingClasses(r)).toEqual(["image-large"]);
  });

  it("needs the original, so downloads off with the original in the cloud is no work", () => {
    const r = record({
      canonical_target: 4272,
      original_placement: "cloud",
      sizes: [here(320, "smaller"), here(640, "smaller"), here(1280, "smaller")],
    });
    const switches = { derivePhotoStandIns: true, deriveVideoStandIns: false, mayDownload: false };
    expect(sweepWork([r], "full", switches, ["image-xsmall", "image-thumb"])).toEqual([]);
    expect(sweepWork([r], "full", { ...switches, mayDownload: true }, ["image-xsmall", "image-thumb"])).toEqual([r]);
  });

  it("derives nothing for an original still waiting for its stamp", () => {
    // No node has stamped it, so the platform names no target and nothing here
    // can say what a stand-in for it should be. The cloud stamps it on the next
    // exchange and the sweep after that derives the ladder.
    const r = record({ status: "awaiting-stamp", canonical_target: null, top: null, sizes: [] });
    expect(missingClasses(r)).toEqual([]);
  });
});
