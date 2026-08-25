/**
 * The phone's work graph (item 14).
 *
 * These are policy assertions, not implementation ones. Each corresponds to a
 * decision that is cheap to get wrong and expensive to notice: a phone that
 * uploads over cellular, a phone that cannot evict because it is full, a phone
 * that never syncs because it is never plugged in. All three work fine on a dev
 * handset on a desk, which is precisely why they are asserted here rather than
 * discovered in use.
 */
import { describe, it, expect } from "vitest";
import {
  JOB_GRAPH,
  jobSpec,
  preferredOrder,
  runnableJobs,
  canRun,
  backoffMs,
  fullDeriveMayRun,
  FULL_DERIVE_BATTERY_FLOOR,
  MAX_BACKOFF_MS,
  MIN_BACKOFF_MS,
  type DeviceState,
} from "../src/work/job-graph";

const device = (over: Partial<DeviceState> = {}): DeviceState => ({
  hasNetwork: true,
  isUnmetered: true,
  isCharging: true,
  isStorageLow: false,
  batteryLevel: 1,
  ...over,
});

describe("the four constraints", () => {
  // Constraint 1. A job that cannot be abandoned cannot be scheduled at all
  // under a model where the OS decides when the app stops.
  it("has no job that is unsafe to abandon", () => {
    for (const job of JOB_GRAPH) {
      expect(job.resumable, job.id).toBe(true);
    }
  });

  // Constraint 2. A unit that cannot finish inside its window never finishes,
  // so it retries forever and the phone makes no progress at all — which looks
  // identical to the app being broken.
  it("sizes every unit in seconds, not minutes", () => {
    for (const job of JOB_GRAPH) {
      expect(job.targetSecondsPerUnit, job.id).toBeLessThanOrEqual(10);
    }
  });

  // Constraint 3. A transfer the app performs itself dies when the app does,
  // which on a phone is constantly.
  it("delegates every large byte transfer to the OS", () => {
    expect(jobSpec("fetch-blobs").delegatedTransfer).toBe(true);
    expect(jobSpec("push-blobs").delegatedTransfer).toBe(true);
  });

  it("does not delegate work that is not a byte transfer", () => {
    // Handing a metadata exchange to a download manager would be nonsense; the
    // flag marks a real mechanism, not an aspiration.
    expect(jobSpec("sync-metadata").delegatedTransfer).toBe(false);
    expect(jobSpec("evict").delegatedTransfer).toBe(false);
  });
});

describe("network policy", () => {
  // A phone that uploads a 4 GB video over cellular has not done the user a
  // favour, however correct the transfer was — and a metered-data bill is harm
  // no retry logic undoes.
  it("moves bytes only on an unmetered connection", () => {
    expect(jobSpec("fetch-blobs").constraints.requiresUnmetered).toBe(true);
    expect(jobSpec("push-blobs").constraints.requiresUnmetered).toBe(true);
  });

  // Metadata is small, and the library staying browsable is worth a few
  // kilobytes — it is what makes elided records visible at all.
  it("exchanges metadata even on cellular", () => {
    expect(jobSpec("sync-metadata").constraints.requiresUnmetered).toBe(false);
    expect(jobSpec("sync-metadata").constraints.requiresNetwork).toBe(true);
  });

  // A phone in airplane mode must not forget what it shot.
  it("scans the camera roll with no network at all", () => {
    expect(jobSpec("scan-media-store").constraints.requiresNetwork).toBe(false);
  });
});

describe("battery policy", () => {
  // The sizes a library needs to be viewable at all are exempt. Gating them on
  // a charger means a phone that is rarely plugged in shows a grid of
  // placeholders for its own camera roll — and it gates more than the grid,
  // because `image-medium` is the rung on-device AI reads, so every model on
  // the phone would be waiting for a cable too.
  it("makes the viewable sizes whatever the power state", () => {
    expect(canRun(jobSpec("derive-ladder-cheap"), device({ isCharging: false, batteryLevel: 0.1 })))
      .toBe(true);
  });

  // A phone that is never plugged in would otherwise never sync, which is
  // worse than a slightly emptier battery.
  it("requires charging for nothing at all, as an OS constraint", () => {
    // The one job with a power rule expresses it as a runtime check instead —
    // see below — because WorkManager cannot say "charging or above half".
    for (const job of JOB_GRAPH) {
      expect(job.constraints.requiresCharging, job.id).toBe(false);
    }
  });

  describe("the expensive sizes", () => {
    it("run while charging, at any level", () => {
      expect(fullDeriveMayRun(device({ isCharging: true, batteryLevel: 0.05 }))).toBe(true);
    });

    it("run unplugged when there is comfortable charge", () => {
      const above = Math.min(1, FULL_DERIVE_BATTERY_FLOOR + 0.1);
      expect(fullDeriveMayRun(device({ isCharging: false, batteryLevel: above }))).toBe(true);
    });

    it("wait when unplugged and low", () => {
      const below = Math.max(0, FULL_DERIVE_BATTERY_FLOOR - 0.1);
      expect(fullDeriveMayRun(device({ isCharging: false, batteryLevel: below }))).toBe(false);
      expect(canRun(jobSpec("derive-ladder-full"), device({ isCharging: false, batteryLevel: below })))
        .toBe(false);
    });

    // Deferring on an unknown battery is the safe direction: the work resumes
    // for free next time the phone is charged, and the alternative is a job
    // that runs flat out on a device whose power state nothing could read.
    it("wait when the battery level cannot be read", () => {
      expect(fullDeriveMayRun({ ...device({ isCharging: false }), batteryLevel: undefined }))
        .toBe(false);
    });
  });
});

describe("storage policy", () => {
  // The deadlock this avoids: the phone fills up, and then cannot run the one
  // job that would empty it.
  it("lets eviction run even when storage is low", () => {
    expect(canRun(jobSpec("evict"), device({ isStorageLow: true }))).toBe(true);
  });

  it("stops everything else when storage is low", () => {
    const runnable = runnableJobs(device({ isStorageLow: true }));
    expect(runnable).toEqual(["evict"]);
  });
});

describe("ordering", () => {
  const order = preferredOrder();
  const before = (a: string, b: string) => order.indexOf(a as never) < order.indexOf(b as never);

  it("respects every declared dependency", () => {
    for (const job of JOB_GRAPH) {
      for (const dep of job.after) {
        expect(before(dep, job.id), `${dep} should precede ${job.id}`).toBe(true);
      }
    }
  });

  // Renditions before originals is the rule the whole storage design rests on;
  // pushing before deriving would send a 40 MB original where a 130 KB
  // rendition would have done.
  it("derives before it pushes", () => {
    expect(before("derive-ladder-cheap", "push-blobs")).toBe(true);
  });

  // The library becoming legible everywhere beats one photo becoming sharp —
  // the same reason the desktop sweep stages across the library rather than
  // within a record.
  it("makes the viewable sizes before the expensive ones", () => {
    expect(before("derive-ladder-cheap", "derive-ladder-full")).toBe(true);
  });

  // Fetching before the metadata round is fetching against a stale idea of
  // what exists.
  it("syncs metadata before moving any bytes", () => {
    expect(before("sync-metadata", "fetch-blobs")).toBe(true);
    expect(before("sync-metadata", "push-blobs")).toBe(true);
  });

  // Eviction must know what is durable elsewhere before dropping anything.
  it("syncs metadata before evicting", () => {
    expect(before("sync-metadata", "evict")).toBe(true);
  });

  // The queue the fetch drains is written by the scan, so a fetch that ran
  // first would work through yesterday's idea of what this device is missing.
  it("scans for what is missing before fetching it", () => {
    expect(before("scan-acquirable", "fetch-blobs")).toBe(true);
    expect(before("sync-metadata", "scan-acquirable")).toBe(true);
  });

  it("includes every job exactly once", () => {
    expect(order).toHaveLength(JOB_GRAPH.length);
    expect(new Set(order).size).toBe(JOB_GRAPH.length);
  });
});

describe("what runs under real conditions", () => {
  it("runs everything on wifi while charging", () => {
    expect(runnableJobs(device())).toHaveLength(JOB_GRAPH.length);
  });

  // The common case, and the one worth being sure about: a phone in a pocket on
  // cellular keeps the library browsable and moves no bytes.
  it("on cellular, off charge: metadata and local work only", () => {
    const runnable = runnableJobs(
      device({ isUnmetered: false, isCharging: false, batteryLevel: 0.2 }),
    );
    expect(runnable).toContain("sync-metadata");
    expect(runnable).toContain("scan-media-store");
    expect(runnable).not.toContain("fetch-blobs");
    expect(runnable).not.toContain("push-blobs");
    // The expensive rungs wait for power; the viewable ones do not.
    expect(runnable).toContain("derive-ladder-cheap");
    expect(runnable).not.toContain("derive-ladder-full");
  });

  // Offline is not idle. A phone in airplane mode can still notice what the
  // camera shot, derive renditions from it, and free space — and a design that
  // stopped all three would waste exactly the window (overnight, on charge,
  // no signal) that is best for the expensive work.
  it("offline: everything that touches nothing remote still runs", () => {
    const runnable = runnableJobs(device({ hasNetwork: false, isUnmetered: false }));
    expect(runnable).toContain("scan-media-store");
    expect(runnable).toContain("derive-ladder-cheap");
    expect(runnable).toContain("derive-ladder-full");
    expect(runnable).toContain("evict");
    // And nothing that does touch the network.
    expect(runnable).not.toContain("sync-metadata");
    expect(runnable).not.toContain("fetch-blobs");
    expect(runnable).not.toContain("push-blobs");
  });

  it("offline and low on charge defers only the expensive sizes", () => {
    // The power rule showing through rather than the network one — and showing
    // through only where it should, since a placeholder grid is not what a user
    // deserves for being unplugged.
    const runnable = runnableJobs(
      device({ hasNetwork: false, isUnmetered: false, isCharging: false, batteryLevel: 0.2 }),
    );
    expect(runnable).toContain("derive-ladder-cheap");
    expect(runnable).not.toContain("derive-ladder-full");
  });
});

describe("backoff", () => {
  it("grows with each attempt", () => {
    expect(backoffMs(1)).toBe(MIN_BACKOFF_MS);
    expect(backoffMs(2)).toBeGreaterThan(backoffMs(1));
    expect(backoffMs(3)).toBeGreaterThan(backoffMs(2));
  });

  // The cap matters more than the curve. Uncapped, a phone offline for a week
  // comes back with a retry delay measured in days — so the first thing it does
  // on regaining connectivity is nothing.
  it("is capped, so a long outage does not become a longer silence", () => {
    expect(backoffMs(50)).toBe(MAX_BACKOFF_MS);
    expect(MAX_BACKOFF_MS).toBeLessThanOrEqual(60 * 60_000);
  });

  it("does not delay a first attempt", () => {
    expect(backoffMs(0)).toBe(0);
  });
});
