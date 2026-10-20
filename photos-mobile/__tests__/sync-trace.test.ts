/**
 * The phone's sync trace: one row per round, the stop reason on the last, and
 * a bound on how much it keeps.
 *
 * Run over a real SQLite engine, because the store compiles its own statements
 * and the only way to know they are right is to execute them.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { ExchangeResult, SyncResult } from "@starkeep/sync-engine";
import {
  createSyncTraceStore,
  formatSyncTrace,
  stopReasonOf,
} from "../src/work/sync-trace";

const round = (over: Partial<ExchangeResult> = {}): ExchangeResult => ({
  applied: 0,
  landed: 0,
  landedBytes: 0,
  uploaded: 0,
  uploadedBytes: 0,
  shipped: 0,
  bytesHasMore: false,
  hasMore: false,
  outboundHasMore: false,
  blocked: false,
  progressed: false,
  elided: 0,
  ...over,
});

function store(keep?: number) {
  const db = new DatabaseSync(":memory:");
  return createSyncTraceStore(db as never, keep);
}

describe("createSyncTraceStore", () => {
  it("records each round with what it moved, newest first", () => {
    const trace = store();
    trace.recordRound("s1", "timer", 1, 1_000, round({ applied: 3, shipped: 2, uploaded: 1, uploadedBytes: 4096 }));
    trace.recordRound("s1", "timer", 2, 2_000, round({ landed: 5, landedBytes: 900, bytesHasMore: true }));

    const [second, first] = trace.recent(10);
    expect(first).toMatchObject({ syncId: "s1", trigger: "timer", round: 1, applied: 3, shipped: 2, uploaded: 1, uploadedBytes: 4096 });
    expect(second).toMatchObject({ round: 2, landed: 5, landedBytes: 900, bytesHasMore: true, stopReason: null });
  });

  it("puts the stop reason on the sync's last round only", () => {
    const trace = store();
    trace.recordRound("s1", "open", 1, 0, round());
    trace.recordRound("s1", "open", 2, 0, round());
    trace.finish("s1", "open", 0, "complete");

    const [last, earlier] = trace.recent(10);
    expect(last!.stopReason).toBe("complete");
    expect(earlier!.stopReason).toBeNull();
  });

  it("gives a sync that ran no round a row of its own", () => {
    const trace = store();
    trace.finish("s2", "media-change", 5_000, "aborted");
    expect(trace.recent(10)).toEqual([
      expect.objectContaining({ syncId: "s2", trigger: "media-change", round: 0, stopReason: "aborted" }),
    ]);
  });

  it("keeps only the most recent rows", () => {
    const trace = store(5);
    for (let i = 1; i <= 12; i += 1) trace.recordRound("s", "timer", i, 0, round());
    const rows = trace.recent(100);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.round)).toEqual([12, 11, 10, 9, 8]);
  });
});

describe("stopReasonOf", () => {
  const result = (over: Partial<SyncResult>): SyncResult => ({
    rounds: 1,
    applied: 0,
    shipped: 0,
    elided: 0,
    complete: false,
    stalled: false,
    ...over,
  });

  it("names each way a sync ends, most specific first", () => {
    expect(stopReasonOf(result({}), false, new Error("boom"))).toBe("error: boom");
    expect(stopReasonOf(result({ complete: true }), true)).toBe("aborted");
    expect(stopReasonOf(null, false)).toBe("no cloud");
    expect(stopReasonOf(result({ complete: true }), false)).toBe("complete");
    expect(stopReasonOf(result({ stalled: true }), false)).toBe("stalled");
    expect(stopReasonOf(result({ refusedAuthors: ["L"] }), false)).toBe("refused authors: L");
    expect(stopReasonOf(result({}), false)).toBe("incomplete");
  });
});

describe("formatSyncTrace", () => {
  it("writes one line per round with what a reader needs to diagnose it", () => {
    const trace = store();
    trace.recordRound("s1", "after-import", 1, 0, round({ uploaded: 2, uploadedBytes: 10, blocked: true }));
    trace.finish("s1", "after-import", 0, "stalled");
    const text = formatSyncTrace(trace.recent(10));
    expect(text).toContain("trigger=after-import");
    expect(text).toContain("uploaded=2/10B");
    expect(text).toContain("blocked=true");
    expect(text).toContain("stop=stalled");
    expect(text.split("\n")).toHaveLength(1);
  });
});
