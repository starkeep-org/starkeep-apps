/**
 * How the sweep decides a record needs work.
 *
 * The expensive mistake this replaces was answering "does this record have
 * renditions?" from a field the query could never populate, so every original
 * was always underived and every page load re-derived the whole library. What
 * makes the answer trustworthy now is that it comes from the same place the
 * derivation itself reads: the child records that actually exist.
 *
 * Assertions are expressed against the ladder rather than literal pixel sizes.
 * Its integers are provisional pending a visual test, and a test pinning `1280`
 * would have to be edited by the change that makes it wrong.
 */
import { describe, it, expect } from "vitest";
import {
  missingClasses,
  needsRecordFacts,
  stageHasWork,
  fetchSweepPage,
  fidelityWithoutDecode,
  originalReadable,
  sweepWork,
  type SweepRecord,
} from "../src/derivation/sweep-set";
import {
  DEFAULT_DERIVATION_CONFIG,
  mayDownloadOriginals,
  mergeDerivationConfig,
} from "../src/derivation/config";
import {
  CHEAP_STILL_CLASSES,
  STILL_LADDER,
  applicableStillClasses,
  renditionLongEdge,
} from "../src/photos-lib/ladder";

const TOP = STILL_LADDER[STILL_LADDER.length - 1]!;
const BIG = TOP.maxLongEdge + 500;

function edgesFor(sourceLongEdge: number): number[] {
  return applicableStillClasses(sourceLongEdge).map((spec) =>
    renditionLongEdge(spec, sourceLongEdge),
  );
}

function record(over: Partial<SweepRecord> = {}): SweepRecord {
  return {
    id: "rec-1",
    mime_type: "image/jpeg",
    original_filename: "photo.jpg",
    metadata: { width: BIG, height: Math.round(BIG * 0.75), thumb_hash: "abc" },
    variant_candidates: [],
    ...over,
  };
}

describe("which rungs are missing", () => {
  it("names every applicable rung when none exist", () => {
    const missing = missingClasses(record());
    expect(missing).toEqual(applicableStillClasses(BIG).map((s) => s.sizeClass));
  });

  it("names none when every applicable rung exists", () => {
    const missing = missingClasses(
      record({
        variant_candidates: edgesFor(BIG).map((long_edge) => ({
          long_edge,
          available_here: true,
        })),
      }),
    );
    expect(missing).toEqual([]);
  });

  // A rung that exists anywhere is done: the platform keeps one stand-in per
  // size, so encoding it again here would be refused, and whether its bytes
  // come to this node is residency's call, not the sweeper's.
  it("counts a rung whose bytes are only in the cloud as present", () => {
    const edges = edgesFor(BIG);
    const missing = missingClasses(
      record({
        variant_candidates: edges.map((long_edge, i) => ({
          long_edge,
          available_here: i % 2 === 0,
        })),
      }),
    );
    expect(missing).toEqual([]);
  });

  // Every rung sits below the source now — none is clamped to it — so a
  // source just above the bottom rung takes the bottom rung and nothing else.
  it("takes only the rungs below a small source, never one clamped to it", () => {
    const small = STILL_LADDER[0]!.maxLongEdge + 1;
    const edges = edgesFor(small);
    expect(edges).toEqual([STILL_LADDER[0]!.maxLongEdge]);
    const missing = missingClasses(
      record({
        metadata: { width: small, height: small, thumb_hash: "abc" },
        variant_candidates: edges.map((long_edge) => ({ long_edge, available_here: true })),
      }),
    );
    expect(missing).toEqual([]);
  });

  it("asks for the canonical rung only of an original that archives behind one", () => {
    expect(missingClasses(record({ size_bytes: 50 * 1024 * 1024 }))).toContain(TOP.sizeClass);
    expect(missingClasses(record({ size_bytes: 300 * 1024 }))).not.toContain(TOP.sizeClass);
  });

  it("cannot rule anything out without the source's dimensions", () => {
    expect(missingClasses(record({ metadata: null }))).toBe("unknown");
  });
});

describe("the record's own facts", () => {
  it("are outstanding without dimensions or without a placeholder", () => {
    expect(needsRecordFacts(record({ metadata: null }))).toBe(true);
    expect(
      needsRecordFacts(record({ metadata: { width: BIG, height: BIG, thumb_hash: null } })),
    ).toBe(true);
  });

  it("are done when both are stored", () => {
    expect(needsRecordFacts(record())).toBe(false);
  });
});

describe("which stage has work", () => {
  const cheapEdges = () => {
    const applicable = applicableStillClasses(BIG);
    return applicable
      .filter((spec) => (CHEAP_STILL_CLASSES as string[]).includes(spec.sizeClass))
      .map((spec) => renditionLongEdge(spec, BIG));
  };

  it("gives a wholly underived record work in all applicable still stages", () => {
    expect(stageHasWork(record(), "cheap", CHEAP_STILL_CLASSES)).toBe(true);
    expect(stageHasWork(record(), "medium", CHEAP_STILL_CLASSES)).toBe(true);
    expect(stageHasWork(record(), "full", CHEAP_STILL_CLASSES)).toBe(true);
  });

  // The point of staging across the library rather than within a record: once
  // the cheap rungs exist for everything, the grid is legible, and the
  // expensive rungs fill in behind it without anything waiting.
  it("leaves only the expensive stage once the cheap rungs exist", () => {
    const partial = record({
      variant_candidates: cheapEdges().map((long_edge) => ({
        long_edge,
        available_here: true,
      })),
    });
    expect(stageHasWork(partial, "cheap", CHEAP_STILL_CLASSES)).toBe(false);
    expect(stageHasWork(partial, "medium", CHEAP_STILL_CLASSES)).toBe(true);
    expect(stageHasWork(partial, "full", CHEAP_STILL_CLASSES)).toBe(true);
  });

  it("leaves only full work after cheap and medium are present", () => {
    const throughMedium = applicableStillClasses(BIG)
      .filter((spec) => spec.maxLongEdge <= 1280)
      .map((spec) => ({ long_edge: renditionLongEdge(spec, BIG), available_here: true }));
    const partial = record({ variant_candidates: throughMedium });
    expect(stageHasWork(partial, "cheap", CHEAP_STILL_CLASSES)).toBe(false);
    expect(stageHasWork(partial, "medium", CHEAP_STILL_CLASSES)).toBe(false);
    expect(stageHasWork(partial, "full", CHEAP_STILL_CLASSES)).toBe(true);
  });

  it("gives a fully derived record no work at all", () => {
    const done = record({
      variant_candidates: edgesFor(BIG).map((long_edge) => ({
        long_edge,
        available_here: true,
      })),
    });
    expect(stageHasWork(done, "cheap", CHEAP_STILL_CLASSES)).toBe(false);
    expect(stageHasWork(done, "medium", CHEAP_STILL_CLASSES)).toBe(false);
    expect(stageHasWork(done, "full", CHEAP_STILL_CLASSES)).toBe(false);
  });

  it("gives a record with no dimensions cheap work, since that pass supplies them", () => {
    const unknown = record({ metadata: null });
    expect(stageHasWork(unknown, "cheap", CHEAP_STILL_CLASSES)).toBe(true);
  });

  it("uses the canonical type when watched-folder ingest intentionally leaves MIME null", () => {
    const watched = record({ type: "image/jpeg", mime_type: null, metadata: null });
    expect(stageHasWork(watched, "cheap", CHEAP_STILL_CLASSES)).toBe(true);
    expect(stageHasWork(watched, "video", CHEAP_STILL_CLASSES)).toBe(false);
  });

  it("never sends a video through the still derivation stages", () => {
    const video = record({ mime_type: "video/mp4", metadata: null });
    expect(stageHasWork(video, "cheap", CHEAP_STILL_CLASSES)).toBe(false);
    expect(stageHasWork(video, "medium", CHEAP_STILL_CLASSES)).toBe(false);
    expect(stageHasWork(video, "full", CHEAP_STILL_CLASSES)).toBe(false);
    expect(stageHasWork(video, "video", CHEAP_STILL_CLASSES)).toBe(true);
  });

  it("recognizes a watched-folder video from its canonical type", () => {
    const video = record({ type: "video/mp4", mime_type: null, metadata: null });
    expect(stageHasWork(video, "cheap", CHEAP_STILL_CLASSES)).toBe(false);
    expect(stageHasWork(video, "video", CHEAP_STILL_CLASSES)).toBe(true);
  });

  it("gives a complete video no more work", () => {
    const video = record({
      mime_type: "video/mp4",
      metadata: { width: 1920, height: 1080, bitrate: 8_000_000 },
      variant_candidates: [
        { long_edge: 400, label_value: "video-poster-thumb", available_here: true },
        { long_edge: 1280, label_value: "video-poster-720p", available_here: true },
        { long_edge: 640, label_value: "video-skim", available_here: true },
        { long_edge: 1280, label_value: "video-720p", available_here: true },
        { long_edge: 1920, label_value: "video-1080p", available_here: true },
      ],
    });
    expect(stageHasWork(video, "video", CHEAP_STILL_CLASSES)).toBe(false);
  });

  it("gives a video without its canonical stand-in work, whatever else it has", () => {
    const video = record({
      mime_type: "video/mp4",
      metadata: { width: 1920, height: 1080, bitrate: 8_000_000 },
      variant_candidates: [
        { long_edge: 400, label_value: "video-poster-thumb", available_here: true },
        { long_edge: 1280, label_value: "video-poster-720p", available_here: true },
        { long_edge: 640, label_value: "video-skim", available_here: true },
        { long_edge: 1280, label_value: "video-720p", available_here: true },
      ],
    });
    expect(stageHasWork(video, "video", CHEAP_STILL_CLASSES)).toBe(true);
  });

  it("counts a video rung that exists without local bytes as present", () => {
    const video = record({
      mime_type: "video/mp4",
      metadata: { width: 1920, height: 1080, bitrate: 8_000_000 },
      variant_candidates: [
        { long_edge: 400, label_value: "video-poster-thumb", available_here: true },
        { long_edge: 1280, label_value: "video-poster-720p", available_here: false },
        { long_edge: 640, label_value: "video-skim", available_here: true },
        { long_edge: 1280, label_value: "video-720p", available_here: true },
        { long_edge: 1920, label_value: "video-1080p", available_here: false },
      ],
    });
    expect(stageHasWork(video, "video", CHEAP_STILL_CLASSES)).toBe(false);
  });

  it("does not invent a 720p poster requirement for a completed small video", () => {
    const video = record({
      mime_type: "video/mp4",
      metadata: { width: 400, height: 300, bitrate: 800_000 },
      variant_candidates: [
        { long_edge: 400, label_value: "video-poster-thumb", available_here: true },
        { long_edge: 320, label_value: "video-skim", available_here: true },
        { long_edge: 400, label_value: "video-1080p", available_here: true },
      ],
    });
    expect(stageHasWork(video, "video", CHEAP_STILL_CLASSES)).toBe(false);
  });
});

describe("paging the library", () => {
  it("asks for the unnarrowed candidate list, not a resolution", async () => {
    let asked = "";
    await fetchSweepPage(
      async (path) => {
        asked = path;
        return new Response(JSON.stringify({ records: [], nextCursor: null }));
      },
      "photos/rendition",
      null,
    );
    const params = new URLSearchParams(asked.split("?")[1]);
    expect(params.get("variant")).toBe("photos/rendition");
    // Resolution would answer "which rung best fits 400 px"; the question here
    // is "which rungs are missing", and only the whole set answers it.
    expect(params.get("variantLongEdge")).toBeNull();
    expect(params.get("notLabel")).toBe("photos/rendition");
    expect(params.get("include")).toBe("metadata,labels");
  });

  it("treats a missing nextCursor as the end rather than looping forever", async () => {
    // A server older than the contract omits the field entirely, and
    // `undefined !== null` is an infinite loop rather than an error.
    const page = await fetchSweepPage(
      async () => new Response(JSON.stringify({ records: [] })),
      "photos/rendition",
      null,
    );
    expect(page.nextCursor).toBeNull();
  });

  it("carries the page token when resuming", async () => {
    let asked = "";
    await fetchSweepPage(
      async (path) => {
        asked = path;
        return new Response(JSON.stringify({ records: [], nextCursor: null }));
      },
      "photos/rendition",
      "cursor-abc",
    );
    expect(new URLSearchParams(asked.split("?")[1]).get("page_token")).toBe("cursor-abc");
  });
});

describe("this machine's switches", () => {
  const here = (id: string) =>
    record({
      id,
      stand_ins: { category: "image", fidelity: BIG, status: "archivable", top: 4272, sizes: [], original_placement: "here" },
    });
  const cloudOnly = (id: string) =>
    record({
      id,
      stand_ins: { category: "image", fidelity: BIG, status: "archivable", top: 4272, sizes: [], original_placement: "cloud" },
    });
  const all = { derivePhotoStandIns: true, deriveVideoStandIns: true, mayDownload: true };

  it("default to deriving everything and downloading what is missing", () => {
    expect(DEFAULT_DERIVATION_CONFIG).toEqual({
      derivePhotoStandIns: true,
      deriveVideoStandIns: true,
      downloadOriginalsToDerive: true,
    });
    expect(mayDownloadOriginals(DEFAULT_DERIVATION_CONFIG)).toBe(true);
  });

  it("take booleans field by field and ignore anything else", () => {
    expect(
      mergeDerivationConfig(DEFAULT_DERIVATION_CONFIG, { deriveVideoStandIns: false, derivePhotoStandIns: "no" }),
    ).toEqual({ derivePhotoStandIns: true, deriveVideoStandIns: false, downloadOriginalsToDerive: true });
  });

  it("allow no download while both derive switches are off", () => {
    expect(
      mayDownloadOriginals({ derivePhotoStandIns: false, deriveVideoStandIns: false, downloadOriginalsToDerive: true }),
    ).toBe(false);
  });

  it("derive no stills with photo derivation off, and no video with video derivation off", () => {
    const records = [here("a")];
    expect(sweepWork(records, "cheap", { ...all, derivePhotoStandIns: false }, CHEAP_STILL_CLASSES)).toEqual([]);
    expect(sweepWork(records, "cheap", all, CHEAP_STILL_CLASSES).map((r) => r.id)).toEqual(["a"]);
    const video = record({ id: "v", mime_type: "video/mp4", metadata: { width: 0, height: 0 } });
    expect(sweepWork([video], "video", { ...all, deriveVideoStandIns: false }, CHEAP_STILL_CLASSES)).toEqual([]);
    expect(sweepWork([video], "video", all, CHEAP_STILL_CLASSES).map((r) => r.id)).toEqual(["v"]);
  });

  // Any read of an original this machine lacks downloads it and keeps it.
  it("read only originals already here with downloads off", () => {
    const records = [here("a"), cloudOnly("b"), record({ id: "c" })];
    expect(
      sweepWork(records, "cheap", { ...all, mayDownload: false }, CHEAP_STILL_CLASSES).map((r) => r.id),
    ).toEqual(["a"]);
    expect(originalReadable(cloudOnly("b"), true)).toBe(true);
    // A server older than the field says nothing, which is not "here".
    expect(originalReadable(record({ id: "c" }), false)).toBe(false);
  });

  it("report a fidelity the stored dimensions answer, for a still with none", () => {
    expect(fidelityWithoutDecode(record({ fidelity: null }))).toBe(BIG);
    expect(fidelityWithoutDecode(record({ fidelity: 6000 }))).toBeNull();
    expect(fidelityWithoutDecode(record({ fidelity: null, metadata: null }))).toBeNull();
    expect(fidelityWithoutDecode(record({ fidelity: null, mime_type: "video/mp4" }))).toBeNull();
  });
});
