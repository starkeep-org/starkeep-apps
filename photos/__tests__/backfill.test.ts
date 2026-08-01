/**
 * Backfilling the ladder across an existing library.
 *
 * Two properties matter more than the rest and both are asserted directly: the
 * job **never transfers an original in order to derive from it**, and it never
 * tells the archive gate a ladder is complete when it is not. The first costs
 * money and a 48-hour thaw when it is wrong; the second freezes an original
 * behind that thaw with nothing readable in front of it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  runBackfill,
  assertLadderMeasured,
  type BackfillCandidate,
  type BackfillDeps,
  type BackfillStore,
} from "../src/photos-lib/backfill/run-backfill";
import {
  shouldAttemptBackfill,
  summarizeBackfill,
  backfillIsComplete,
  MAX_BACKFILL_ATTEMPTS,
  type BackfillItem,
} from "../src/photos-lib/backfill/backfill-run";
import type { SizeClass } from "../src/photos-lib/ladder";

function memoryStore(): BackfillStore & { items: Map<string, BackfillItem> } {
  const items = new Map<string, BackfillItem>();
  return {
    items,
    get: (id) => items.get(id) ?? null,
    put: (item) => void items.set(item.recordId, item),
    all: () => [...items.values()],
  };
}

const candidate = (recordId: string, existing: SizeClass[] = []): BackfillCandidate => ({
  recordId,
  type: "image/jpeg",
  originalFilename: `${recordId}.jpg`,
  existingClasses: existing,
});

let store: ReturnType<typeof memoryStore>;
let readCalls: string[];
let completed: string[];

function deps(over: Partial<BackfillDeps> = {}): BackfillDeps {
  return {
    listCandidates: async () => ({ candidates: [candidate("r1")], nextCursor: null }),
    readLocalOriginal: async (id) => {
      readCalls.push(id);
      return new Uint8Array([1, 2, 3]);
    },
    deriveMissing: async () => ({ produced: ["image-medium", "image-thumb"], missing: [] }),
    onComplete: async (id) => void completed.push(id),
    isUndecodable: (err) => (err as Error).message.includes("no decoder"),
    ...over,
  };
}

const RUN = { ladderMeasured: true, pacing: { delayMs: 0, maxItemsPerRun: null } };

beforeEach(() => {
  store = memoryStore();
  readCalls = [];
  completed = [];
});

describe("the item 9b interlock", () => {
  // Not a note in a document. Backfill applies the ladder to the whole library
  // in one pass, and the archive gate turns a complete ladder into a frozen
  // original — so running on provisional numbers is not "a bit wasteful", it is
  // unrecoverable without paying to thaw everything it froze.
  it("refuses to run while the ladder numbers are provisional", async () => {
    await expect(
      runBackfill(store, deps(), { ladderMeasured: false, pacing: { delayMs: 0, maxItemsPerRun: null } }),
    ).rejects.toThrow(/9b/);
    expect(readCalls, "read an original despite refusing to run").toEqual([]);
  });

  it("names what has to happen before it can run", () => {
    expect(() => assertLadderMeasured(false)).toThrow(/visual test/i);
  });

  it("runs once the numbers are measured", async () => {
    const result = await runBackfill(store, deps(), RUN);
    expect(result.processed).toBe(1);
  });
});

describe("never transferring an original to derive from it", () => {
  // The rule the whole plan is built on. A record whose original is not
  // resident is skipped, not fetched: fetching would cost egress and, once
  // archiving starts, a 48-hour thaw per photo, to make files that could have
  // been derived for free where the bytes already were.
  it("records an absent original as unavailable rather than fetching it", async () => {
    const result = await runBackfill(
      store,
      deps({ readLocalOriginal: async () => null }),
      RUN,
    );
    expect(store.items.get("r1")!.status).toBe("unavailable");
    expect(result.completed).toBe(0);
  });

  it("does not treat an absent original as a failure to retry", async () => {
    // Retrying it would mean asking the same question of the same disk every
    // run, forever, and the answer cannot change without a thaw somebody pays
    // for deliberately.
    const item: BackfillItem = {
      recordId: "r1", status: "unavailable", producedClasses: [],
      detail: null, attempts: 1, updatedAtMs: 0,
    };
    expect(shouldAttemptBackfill(item)).toBe(false);
  });
});

describe("the archive gate", () => {
  it("fires only when every applicable rung exists", async () => {
    await runBackfill(store, deps(), RUN);
    expect(completed).toEqual(["r1"]);
    expect(store.items.get("r1")!.status).toBe("complete");
  });

  // Asserting completeness with a rung missing is how a record ends up frozen
  // behind a thaw with nothing readable in front of it.
  it("stays silent when a rung is still missing", async () => {
    await runBackfill(
      store,
      deps({
        deriveMissing: async () => ({ produced: ["image-thumb"], missing: ["image-large"] }),
      }),
      RUN,
    );
    expect(completed).toEqual([]);
    expect(store.items.get("r1")!.status).toBe("partial");
    expect(store.items.get("r1")!.detail).toContain("image-large");
  });
});

describe("resuming", () => {
  it("skips records already complete", async () => {
    await runBackfill(store, deps(), RUN);
    readCalls = [];
    await runBackfill(store, deps(), RUN);
    expect(readCalls, "re-derived a record that was already complete").toEqual([]);
  });

  it("retries a partial record and only derives what is missing", async () => {
    await runBackfill(
      store,
      deps({ deriveMissing: async () => ({ produced: ["image-thumb"], missing: ["image-large"] }) }),
      RUN,
    );
    expect(store.items.get("r1")!.producedClasses).toEqual(["image-thumb"]);
    expect(shouldAttemptBackfill(store.items.get("r1")!)).toBe(true);
  });

  it("never retries a record this build cannot decode", async () => {
    await runBackfill(
      store,
      deps({ deriveMissing: async () => { throw new Error("no decoder for image/heic"); } }),
      RUN,
    );
    expect(store.items.get("r1")!.status).toBe("undecodable");
    expect(shouldAttemptBackfill(store.items.get("r1")!)).toBe(false);
  });

  // "Retryable" and "retry forever" are not the same thing. A record that has
  // failed five times will not succeed on the sixth in the same run, and
  // continuing costs the throughput of everything behind it in the queue.
  it("gives up on a record after a bounded number of attempts", () => {
    const exhausted: BackfillItem = {
      recordId: "r1", status: "failed", producedClasses: [],
      detail: null, attempts: MAX_BACKFILL_ATTEMPTS, updatedAtMs: 0,
    };
    expect(shouldAttemptBackfill(exhausted)).toBe(false);
    expect(shouldAttemptBackfill({ ...exhausted, attempts: MAX_BACKFILL_ATTEMPTS - 1 })).toBe(true);
  });

  it("counts attempts across runs, not within one", async () => {
    const failing = deps({
      deriveMissing: async () => { throw new Error("network went away"); },
    });
    await runBackfill(store, failing, RUN);
    await runBackfill(store, failing, RUN);
    expect(store.items.get("r1")!.attempts).toBe(2);
  });
});

describe("paging and pacing", () => {
  it("walks every page", async () => {
    const pages: Record<string, { candidates: BackfillCandidate[]; nextCursor: string | null }> = {
      start: { candidates: [candidate("r1")], nextCursor: "p2" },
      p2: { candidates: [candidate("r2")], nextCursor: null },
    };
    const result = await runBackfill(
      store,
      deps({ listCandidates: async (cursor) => pages[cursor ?? "start"]! }),
      RUN,
    );
    expect(result.processed).toBe(2);
    expect(readCalls).toEqual(["r1", "r2"]);
  });

  // Backfill is pure derivation across the whole library on a machine somebody
  // is using. One that finishes in six hours overnight beats one that finishes
  // in two and makes the laptop unusable for those two — nobody is waiting.
  it("stops at the per-run cap and says so", async () => {
    const result = await runBackfill(
      store,
      deps({
        listCandidates: async () => ({
          candidates: [candidate("r1"), candidate("r2"), candidate("r3")],
          nextCursor: null,
        }),
      }),
      { ladderMeasured: true, pacing: { delayMs: 0, maxItemsPerRun: 2 } },
    );
    expect(result.processed).toBe(2);
    expect(result.stoppedEarly).toBe(true);
  });
});

describe("progress reporting", () => {
  const item = (over: Partial<BackfillItem>): BackfillItem => ({
    recordId: "x", status: "pending", producedClasses: [],
    detail: null, attempts: 0, updatedAtMs: 0, ...over,
  });

  it("counts every outcome", () => {
    expect(
      summarizeBackfill([
        item({ status: "complete" }), item({ status: "partial" }),
        item({ status: "failed" }), item({ status: "undecodable" }),
        item({ status: "unavailable" }), item({ status: "pending" }),
      ]),
    ).toEqual({
      total: 6, complete: 1, partial: 1, failed: 1,
      undecodable: 1, unavailable: 1, pending: 1,
    });
  });

  // A library will always hold records this node cannot decode and originals it
  // cannot reach. Reporting the run as unfinished because of them leaves an
  // operator watching a progress bar that never fills.
  it("is finished when only unreachable records remain", () => {
    expect(
      backfillIsComplete(
        summarizeBackfill([
          item({ status: "complete" }), item({ status: "undecodable" }),
          item({ status: "unavailable" }),
        ]),
      ),
    ).toBe(true);
  });

  it("is not finished while anything is partial, failed or pending", () => {
    for (const status of ["partial", "failed", "pending"] as const) {
      expect(backfillIsComplete(summarizeBackfill([item({ status })])), status).toBe(false);
    }
  });
});
