/**
 * What opening the app should set in motion.
 *
 * Every branch here is a rule about *not* doing something — not prompting for a
 * permission nobody asked about, not uploading originals over cellular, not
 * starting a second sync behind a running one, not repeating a pass because
 * somebody glanced at another app. The half that runs is easy; the halves that
 * must not are what this file is for.
 */
import { describe, it, expect } from "vitest";
import {
  planCatchUp,
  CATCH_UP_MIN_INTERVAL_MS,
  type CatchUpState,
} from "../src/work/foreground-catchup";
import type { DeviceState } from "../src/work/job-graph";

const WIFI: DeviceState = {
  hasNetwork: true,
  isUnmetered: true,
  isCharging: false,
  isStorageLow: false,
};

const NOW = 1_700_000_000_000;

function state(overrides: Partial<CatchUpState> = {}): CatchUpState {
  return {
    nodeReady: true,
    syncing: false,
    mediaPermissionGranted: true,
    hasCloud: true,
    device: WIFI,
    lastRunMs: null,
    nowMs: NOW,
    ...overrides,
  };
}

describe("the pass that does both halves", () => {
  it("imports and syncs on a ready node, on Wi-Fi, with permission held", async () => {
    expect(planCatchUp(state())).toEqual({ import: true, sync: true, declined: null });
  });
});

describe("what stops a pass entirely", () => {
  it("plans nothing before the node is open", () => {
    // Not a decline: there is no node yet and the screen already says so.
    expect(planCatchUp(state({ nodeReady: false }))).toEqual({
      import: false,
      sync: false,
      declined: null,
    });
  });

  it("plans nothing while a sync is running", () => {
    // A second caller would serialize behind the first and double the progress
    // counter on the way, and the import half would race the sync it feeds.
    expect(planCatchUp(state({ syncing: true }))).toEqual({
      import: false,
      sync: false,
      declined: null,
    });
  });

  it("plans nothing inside the interval since the last pass", () => {
    // Returning from the permission dialog, the sign-in screen and the share
    // sheet each deliver an `active` transition. One intention, three passes.
    const recent = state({ lastRunMs: NOW - (CATCH_UP_MIN_INTERVAL_MS - 1) });
    expect(planCatchUp(recent)).toEqual({ import: false, sync: false, declined: null });
  });

  it("runs again once the interval has passed", () => {
    const due = state({ lastRunMs: NOW - CATCH_UP_MIN_INTERVAL_MS });
    expect(planCatchUp(due)).toMatchObject({ import: true, sync: true });
  });
});

describe("the import half", () => {
  it("is declined when the permission is not already granted", () => {
    // Never requested from an automatic pass: a system dialog on app launch
    // asks for something before saying what for.
    const plan = planCatchUp(state({ mediaPermissionGranted: false }));
    expect(plan.import).toBe(false);
    expect(plan.sync).toBe(true);
    expect(plan.declined).toContain("no access");
  });
});

describe("the sync half", () => {
  it("is declined on a metered connection, and says which control overrides it", () => {
    // `sync()` moves rows and blobs together, so an automatic pass on cellular
    // uploads originals — the one thing on this device that costs money.
    const plan = planCatchUp(state({ device: { ...WIFI, isUnmetered: false } }));
    expect(plan.sync).toBe(false);
    expect(plan.import).toBe(true);
    expect(plan.declined).toContain("Sync now");
  });

  it("is declined with no network, and says so as offline rather than metered", () => {
    const plan = planCatchUp(
      state({ device: { ...WIFI, hasNetwork: false, isUnmetered: false } }),
    );
    expect(plan.sync).toBe(false);
    expect(plan.declined).toContain("Offline");
  });

  it("is declined, and explained, when the device could not be read", () => {
    const plan = planCatchUp(state({ device: null }));
    expect(plan.sync).toBe(false);
    expect(plan.declined).toContain("could not be read");
  });

  it("is silently absent on a node with no cloud", () => {
    // Not a decline. The Sync section states plainly that nothing leaves this
    // device, and a second sentence would read as a second problem.
    const plan = planCatchUp(state({ hasCloud: false }));
    expect(plan.sync).toBe(false);
    expect(plan.import).toBe(true);
    expect(plan.declined).toBeNull();
  });

  it("names the sync decline ahead of the import one when both apply", () => {
    // The import half has its own control on the same screen saying the same
    // thing; the sync half has nothing else that would ever mention it.
    const plan = planCatchUp(
      state({ mediaPermissionGranted: false, device: { ...WIFI, isUnmetered: false } }),
    );
    expect(plan).toMatchObject({ import: false, sync: false });
    expect(plan.declined).toContain("Wi");
  });
});
