/**
 * One window of work, and what decides its shape.
 *
 * The assertions here are the ones a handset cannot make cheaply: that the
 * metered check actually holds sync back, that the deadline stops the loop
 * rather than the round cap, that a failing job does not take the window with
 * it, and that a job with no implementation is reported rather than silently
 * skipped. Every one of them looks fine on a dev handset on a desk.
 */
import { describe, it, expect, vi } from "vitest";
import {
  DERIVE_DEADLINE_SHARE,
  IMPORT_DEADLINE_SHARE,
  inFlightJob,
  runWorkTick,
  SYNC_DEADLINE_SHARE,
  UNBOUND_JOBS,
  type TickReport,
} from "../src/work/tick";
import { JOB_GRAPH, type DeviceState } from "../src/work/job-graph";
import type { MobileNode } from "../src/node";

const device = (over: Partial<DeviceState> = {}): DeviceState => ({
  hasNetwork: true,
  isUnmetered: true,
  isCharging: true,
  isStorageLow: false,
  batteryLevel: 1,
  ...over,
});

function fakeNode(over: Partial<MobileNode> = {}): MobileNode {
  return {
    sync: vi.fn(async () => ({
      rounds: 2,
      applied: 1,
      shipped: 1,
      elided: 0,
      complete: true,
      stalled: false,
    })),
    scanForAcquirable: vi.fn(async () => ({ queued: 3, complete: true })),
    acquireQueued: vi.fn(async () => []),
    reclaimSpace: vi.fn(async () => []),
    ...over,
  } as unknown as MobileNode;
}

const deps = (over: Record<string, unknown> = {}) => ({
  node: fakeNode(),
  device: device(),
  importRecent: vi.fn(async () => ({ imported: 2, skipped: 8, failed: 0 })),
  log: () => undefined,
  ...over,
});

const far = () => ({ deadlineMs: Date.now() + 60_000 });
const find = (report: Awaited<ReturnType<typeof runWorkTick>>, job: string) =>
  report.outcomes.find((o) => o.job === job)!;

describe("what runs", () => {
  it("considers every job the graph declares", async () => {
    const report = await runWorkTick(deps(), far());
    expect(report.outcomes.map((o) => o.job).sort()).toEqual(JOB_GRAPH.map((j) => j.id).sort());
  });

  it("runs the bound jobs on a device with good conditions", async () => {
    const d = deps();
    const report = await runWorkTick(d, far());
    expect(find(report, "scan-media-store").detail).toContain("imported=2");
    expect(find(report, "sync-metadata").detail).toContain("shipped=1");
    expect(find(report, "scan-acquirable").detail).toContain("queued=3");
    expect(d.node.sync).toHaveBeenCalledTimes(1);
  });

  it("reports a job with no implementation rather than omitting it", async () => {
    const report = await runWorkTick(deps(), far());
    for (const job of UNBOUND_JOBS) {
      expect(find(report, job).ran).toBe(false);
      expect(find(report, job).detail).toContain("no implementation");
    }
  });

  it("names the condition that ruled a job out", async () => {
    const report = await runWorkTick(deps({ device: device({ hasNetwork: false }) }), far());
    expect(find(report, "sync-metadata").detail).toBe("no network");
    expect(find(report, "fetch-blobs").detail).toBe("no network");
    // Local work still runs on a phone with no signal, which is the whole point
    // of `scan-media-store` declaring no network at all.
    expect(find(report, "scan-media-store").ran).toBe(true);
  });
});

describe("the metered connection", () => {
  it("holds sync back entirely, because one call moves blobs as well as rows", async () => {
    const d = deps({ device: device({ isUnmetered: false }) });
    const report = await runWorkTick(d, far());
    expect(d.node.sync).not.toHaveBeenCalled();
    expect(find(report, "sync-metadata").detail).toContain("metered");
    expect(find(report, "push-blobs").detail).toBe("connection is metered");
  });

  it("still runs the jobs that cost nothing to a data plan", async () => {
    const report = await runWorkTick(deps({ device: device({ isUnmetered: false }) }), far());
    expect(find(report, "scan-media-store").ran).toBe(true);
    expect(find(report, "scan-acquirable").ran).toBe(true);
    expect(find(report, "evict").ran).toBe(true);
  });
});

describe("the deadline", () => {
  it("stops before starting a job once the window has closed", async () => {
    const d = deps();
    const report = await runWorkTick(d, { deadlineMs: Date.now() - 1 });
    expect(report.ranOutOfTime).toBe(true);
    expect(report.outcomes).toHaveLength(0);
    expect(d.importRecent).not.toHaveBeenCalled();
  });

  it("gives sync a share of the window rather than all of it", async () => {
    // Without a share, a first library upload consumes every window and the
    // jobs behind sync — eviction most of all — never run at all.
    let seen = 0;
    const node = fakeNode({
      sync: vi.fn(async (options?: { signal?: { aborted: boolean } }) => {
        seen = Date.now();
        expect(options?.signal?.aborted).toBe(false);
        return { rounds: 1, applied: 0, shipped: 0, elided: 0, complete: false, stalled: false };
      }),
    });
    const deadlineMs = Date.now() + 10_000;
    await runWorkTick(deps({ node }), { deadlineMs });
    expect(seen).toBeLessThan(deadlineMs);
    expect(SYNC_DEADLINE_SHARE).toBeLessThan(1);
  });

  it("abandons the sync when its own share elapses", async () => {
    const node = fakeNode({
      sync: vi.fn(async (options?: { signal?: { aborted: boolean } }) => {
        // The signal is a getter over the clock, so a slow round observes the
        // deadline without anything having to fire.
        await new Promise((r) => setTimeout(r, 40));
        expect(options?.signal?.aborted).toBe(true);
        return { rounds: 1, applied: 0, shipped: 0, elided: 0, complete: false, stalled: false };
      }),
    });
    await runWorkTick(deps({ node }), { deadlineMs: Date.now() + 20 });
  });
});

describe("import's own share", () => {
  it("bounds import so a first tick does not spend the window hashing", async () => {
    // The failure this prevents: an un-imported camera roll takes the whole
    // window, the worker is killed rather than stopped, and nothing uploads —
    // on the very tick where there is most to upload.
    let signal: { readonly aborted: boolean } | null = null;
    const importRecent = vi.fn(async (s: { readonly aborted: boolean }) => {
      signal = s;
      await new Promise((r) => setTimeout(r, 40));
      return { imported: 0, skipped: 0, failed: 0 };
    });
    await runWorkTick(deps({ importRecent }), { deadlineMs: Date.now() + 20 });
    expect(signal!.aborted).toBe(true);
    expect(IMPORT_DEADLINE_SHARE).toBeLessThan(SYNC_DEADLINE_SHARE);
  });

  it("leaves the rest of the window to sync", async () => {
    const d = deps();
    await runWorkTick(d, { deadlineMs: Date.now() + 60_000 });
    expect(d.node.sync).toHaveBeenCalledTimes(1);
    expect(d.importRecent).toHaveBeenCalledTimes(1);
  });
});

describe("derivation", () => {
  const derived = (over: Partial<Record<string, number | boolean>> = {}) => ({
    scanned: 1,
    written: 3,
    failed: 0,
    complete: false,
    ...over,
  });

  it("runs the sweep and reports what it made", async () => {
    const deriveRenditions = vi.fn(async () => derived());
    const report = await runWorkTick(deps({ deriveRenditions }), far());

    expect(find(report, "derive-ladder-cheap").ran).toBe(true);
    expect(find(report, "derive-ladder-cheap").detail).toContain("rungs=3");
    expect(deriveRenditions).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a caller that offers no derivation from a device that cannot", async () => {
    // Two different sentences for two different facts, and neither is a
    // failure: nothing wired it up, versus a build with no encoder in it.
    const absent = await runWorkTick(deps(), far());
    expect(find(absent, "derive-ladder-cheap").ran).toBe(true);
    expect(find(absent, "derive-ladder-cheap").detail).toContain("nothing here derives");

    const unable = await runWorkTick(deps({ deriveRenditions: async () => null }), far());
    expect(find(unable, "derive-ladder-cheap").detail).toContain("cannot derive");
  });

  it("gives derivation a share of what is left rather than the rest of the window", async () => {
    // Eviction is behind derivation in the graph's order, and eviction is what
    // frees the space a rendition is written into. A sweep that spent
    // everything left would be a phone that derives until its disk is full and
    // then cannot derive again.
    let signal: { readonly aborted: boolean } | null = null;
    const deriveRenditions = vi.fn(async (s: { readonly aborted: boolean }) => {
      signal = s;
      await new Promise((r) => setTimeout(r, 40));
      return derived();
    });
    await runWorkTick(deps({ deriveRenditions }), { deadlineMs: Date.now() + 30 });

    // The signal is a getter over the clock, so a long sweep observes its share
    // expiring without anything having to fire.
    expect(signal!.aborted).toBe(true);
    expect(DERIVE_DEADLINE_SHARE).toBeLessThan(1);
  });

  it("keeps the expensive rungs unbound", async () => {
    const report = await runWorkTick(deps({ deriveRenditions: async () => derived() }), far());

    // 2560 and 4272 pixels on a side is real CPU for pixels no phone screen can
    // show. They stay a `sharp` node's work.
    expect(UNBOUND_JOBS).toEqual(["derive-ladder-full"]);
    expect(find(report, "derive-ladder-full").ran).toBe(false);
  });
});

describe("failure", () => {
  it("records a failing job and carries on with the rest of the window", async () => {
    const node = fakeNode({
      sync: vi.fn(async () => {
        throw new Error("transport died");
      }),
    });
    const report = await runWorkTick(deps({ node }), far());
    expect(find(report, "sync-metadata").ran).toBe(false);
    expect(find(report, "sync-metadata").detail).toContain("transport died");
    // Eviction sits behind sync in the order, and is what frees the space a
    // failing transfer may be blocked on.
    expect(find(report, "evict").ran).toBe(true);
  });

  it("reports a node with no cloud rather than treating it as an error", async () => {
    const node = fakeNode({ sync: vi.fn(async () => null) });
    const report = await runWorkTick(deps({ node }), far());
    expect(find(report, "sync-metadata").ran).toBe(true);
    expect(find(report, "sync-metadata").detail).toContain("no cloud");
  });
});

/**
 * What a watchdog outside the tick has to write when a job never returns.
 *
 * A window wedged on a native call writes no report of its own, and a report
 * that never arrives is indistinguishable from a process that never woke —
 * which is the ambiguity that cost three sessions of diagnosis. These snapshots
 * are the only record such a window leaves.
 */
describe("progress, for a window that may not survive", () => {
  it("names the job in flight while it is running", async () => {
    const snapshots: TickReport[] = [];
    const stalls = new Promise<never>(() => undefined);
    const node = fakeNode({ scanForAcquirable: vi.fn(() => stalls) });
    void runWorkTick(deps({ node, onProgress: (s: TickReport) => snapshots.push(s) }), far());
    await new Promise((resolve) => setImmediate(resolve));

    const latest = snapshots[snapshots.length - 1]!;
    expect(inFlightJob(latest)).toBe("scan-acquirable");
  });

  it("names no job between them", async () => {
    const snapshots: TickReport[] = [];
    await runWorkTick(deps({ onProgress: (s: TickReport) => snapshots.push(s) }), far());
    expect(inFlightJob(snapshots[snapshots.length - 1]!)).toBeNull();
  });

  it("carries everything already finished, so an abandoned window still reports it", async () => {
    const snapshots: TickReport[] = [];
    const stalls = new Promise<never>(() => undefined);
    const node = fakeNode({ scanForAcquirable: vi.fn(() => stalls) });
    void runWorkTick(deps({ node, onProgress: (s: TickReport) => snapshots.push(s) }), far());
    await new Promise((resolve) => setImmediate(resolve));

    const latest = snapshots[snapshots.length - 1]!;
    expect(find(latest, "scan-media-store").detail).toBe("imported=2 skipped=8 failed=0");
    expect(find(latest, "sync-metadata").ran).toBe(true);
  });

  it("reports once before any job has been considered", async () => {
    const snapshots: TickReport[] = [];
    await runWorkTick(deps({ onProgress: (s: TickReport) => snapshots.push(s) }), far());
    expect(snapshots[0]!.outcomes).toEqual([]);
  });
});
