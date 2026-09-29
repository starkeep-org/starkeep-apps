/**
 * The platform's stand-in summary, folded into the candidate list Photos
 * resolves over. Everything past this adapter is unchanged, so what is pinned
 * here is exactly the translation: which sizes become candidates, under which
 * rung name, with which availability and dimensions.
 */
import { describe, it, expect } from "vitest";
import {
  candidatesFromStandIns,
  withStandInCandidates,
  ORIGINAL_RUNG,
  type StandInRecord,
  type WireStandInSize,
} from "../src/photos-lib/stand-in-candidates";

const NOW = Date.UTC(2026, 8, 28);

function size(over: Partial<WireStandInSize>): WireStandInSize {
  return {
    fidelity: 640,
    role: "smaller",
    record_id: "si-640",
    type: "image/avif",
    size_bytes: 30_000,
    placement: "here",
    ...over,
  };
}

function record(sizes: WireStandInSize[], over: Partial<StandInRecord> = {}): StandInRecord {
  return {
    id: "orig",
    type: "image/jpeg",
    metadata: { width: 6000, height: 4000 },
    stand_ins: { category: "image", fidelity: 6000, status: "archivable", top: 4272, sizes },
    ...over,
  };
}

describe("candidatesFromStandIns", () => {
  it("names each stand-in by its rung in Photos' ladder", () => {
    const got = candidatesFromStandIns(
      record([
        size({ fidelity: 320, record_id: "a" }),
        size({ fidelity: 1280, record_id: "b" }),
        size({ fidelity: 4272, role: "canonical", record_id: "c" }),
      ]),
      NOW,
    );
    expect(got.map((c) => [c.id, c.label_value, c.long_edge])).toEqual([
      ["a", "image-xsmall", 320],
      ["b", "image-medium", 1280],
      ["c", "image-large", 4272],
    ]);
  });

  it("leaves out sizes nobody has produced", () => {
    const got = candidatesFromStandIns(
      record([size({ placement: "missing", record_id: null, type: null })]),
      NOW,
    );
    expect(got).toEqual([]);
  });

  it("reports availability from where the bytes sit on this node", () => {
    const [here, cloud] = candidatesFromStandIns(
      record([size({ fidelity: 320, placement: "here" }), size({ fidelity: 640, placement: "cloud", record_id: "b" })]),
      NOW,
    );
    expect(here!.available_here).toBe(true);
    expect(cloud!.available_here).toBe(false);
  });

  it("derives each stand-in's dimensions from the original's aspect ratio", () => {
    const [landscape] = candidatesFromStandIns(record([size({ fidelity: 1280 })]), NOW);
    expect(landscape).toMatchObject({ width: 1280, height: 853 });
    const [portrait] = candidatesFromStandIns(
      record([size({ fidelity: 1280 })], { metadata: { width: 3000, height: 4000 } }),
      NOW,
    );
    expect(portrait).toMatchObject({ width: 960, height: 1280 });
  });

  it("carries a URL with a lifetime only when the summary signed one", () => {
    const [signed, unsigned] = candidatesFromStandIns(
      record([size({ fidelity: 320, url: "https://files.test/a" }), size({ fidelity: 640, record_id: "b" })]),
      NOW,
    );
    expect(signed).toMatchObject({ url: "https://files.test/a", url_lifetime: { kind: "expires" } });
    expect(unsigned!.url).toBeUndefined();
  });

  it("lets a self-canonical original answer as itself when a browser can paint it", () => {
    const jpeg = candidatesFromStandIns(
      record([size({ fidelity: 2000, role: "original", record_id: "orig", type: "image/jpeg" })]),
      NOW,
    );
    expect(jpeg.map((c) => c.label_value)).toEqual([ORIGINAL_RUNG]);
    const heic = candidatesFromStandIns(
      record([size({ fidelity: 2000, role: "original", record_id: "orig", type: "image/heic" })]),
      NOW,
    );
    expect(heic).toEqual([]);
  });

  it("skips a stand-in at a standard size Photos' ladder does not name", () => {
    expect(candidatesFromStandIns(record([size({ fidelity: 500 })]), NOW)).toEqual([]);
  });

  it("names video stand-ins by their transcode rungs", () => {
    const video: StandInRecord = {
      id: "clip",
      type: "video/mp4",
      metadata: { width: 1440, height: 810 },
      stand_ins: {
        category: "video",
        fidelity: 1440,
        status: "archivable",
        top: 1440,
        sizes: [
          size({ fidelity: 1280, type: "video/webm", record_id: "v720" }),
          size({ fidelity: 1440, role: "canonical", type: "video/webm", record_id: "vc" }),
        ],
      },
    };
    expect(candidatesFromStandIns(video, NOW).map((c) => c.label_value)).toEqual([
      "video-720p",
      "video-1080p",
    ]);
  });
});

describe("withStandInCandidates", () => {
  it("puts stand-ins ahead of the derived candidates the listing already carried", () => {
    const folded = withStandInCandidates(
      {
        ...record([size({ fidelity: 320, record_id: "a" })]),
        variant_candidates: [
          {
            id: "poster",
            type: "image/jpeg",
            width: 640,
            height: 360,
            long_edge: 640,
            label_value: "video-poster-thumb",
            available_here: true,
          },
        ],
      },
      NOW,
    );
    expect(folded.variant_candidates!.map((c) => c.id)).toEqual(["a", "poster"]);
  });

  it("leaves a record with no summary as it was", () => {
    const plain: StandInRecord = { id: "doc", type: "document/pdf" };
    expect(withStandInCandidates(plain, NOW).variant_candidates).toEqual([]);
  });
});
