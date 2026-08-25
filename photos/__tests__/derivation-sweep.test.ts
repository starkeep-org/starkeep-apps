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
  type SweepRecord,
} from "../src/derivation/sweep-set";
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
      record({ variant_candidates: edgesFor(BIG).map((long_edge) => ({ long_edge })) }),
    );
    expect(missing).toEqual([]);
  });

  // Matching is by effective long edge, because that is what the platform can
  // report without knowing a ladder exists. It is unambiguous: a class applies
  // only when the source exceeds the class below it, so its clamped edge
  // exceeds that class's edge too, and an edge names exactly one rung.
  it("matches a rung clamped to a small source, not to the class maximum", () => {
    const small = STILL_LADDER[0]!.maxLongEdge + 1;
    const edges = edgesFor(small);
    expect(Math.max(...edges)).toBe(small);
    const missing = missingClasses(
      record({
        metadata: { width: small, height: small, thumb_hash: "abc" },
        variant_candidates: edges.map((long_edge) => ({ long_edge })),
      }),
    );
    expect(missing).toEqual([]);
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

  it("gives a wholly underived record work in both stages", () => {
    expect(stageHasWork(record(), "cheap", CHEAP_STILL_CLASSES)).toBe(true);
    expect(stageHasWork(record(), "full", CHEAP_STILL_CLASSES)).toBe(true);
  });

  // The point of staging across the library rather than within a record: once
  // the cheap rungs exist for everything, the grid is legible, and the
  // expensive rungs fill in behind it without anything waiting.
  it("leaves only the expensive stage once the cheap rungs exist", () => {
    const partial = record({
      variant_candidates: cheapEdges().map((long_edge) => ({ long_edge })),
    });
    expect(stageHasWork(partial, "cheap", CHEAP_STILL_CLASSES)).toBe(false);
    expect(stageHasWork(partial, "full", CHEAP_STILL_CLASSES)).toBe(true);
  });

  it("gives a fully derived record no work at all", () => {
    const done = record({
      variant_candidates: edgesFor(BIG).map((long_edge) => ({ long_edge })),
    });
    expect(stageHasWork(done, "cheap", CHEAP_STILL_CLASSES)).toBe(false);
    expect(stageHasWork(done, "full", CHEAP_STILL_CLASSES)).toBe(false);
  });

  it("gives a record with no dimensions cheap work, since that pass supplies them", () => {
    const unknown = record({ metadata: null });
    expect(stageHasWork(unknown, "cheap", CHEAP_STILL_CLASSES)).toBe(true);
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

  it("carries the cursor when resuming", async () => {
    let asked = "";
    await fetchSweepPage(
      async (path) => {
        asked = path;
        return new Response(JSON.stringify({ records: [], nextCursor: null }));
      },
      "photos/rendition",
      "cursor-abc",
    );
    expect(new URLSearchParams(asked.split("?")[1]).get("cursor")).toBe("cursor-abc");
  });
});
