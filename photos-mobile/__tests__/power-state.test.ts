import { describe, expect, it } from "vitest";
import { fullDeriveMayRun } from "../src/work/job-graph";
import { BATTERY_STATE, readPowerState } from "../src/work/power-state";

const base = { hasNetwork: true, isUnmetered: true, isStorageLow: false };

const state = (
  batteryState: number,
  batteryLevel: number,
  lowPowerMode = false,
) => ({ batteryState, batteryLevel, lowPowerMode });

describe("the Expo Battery adapter", () => {
  it("allows charging and full states", async () => {
    for (const batteryState of [BATTERY_STATE.CHARGING, BATTERY_STATE.FULL]) {
      const device = await readPowerState(base, {
        getPowerState: async () => state(batteryState, 0.1),
      });
      expect(fullDeriveMayRun(device)).toBe(true);
    }
  });

  it("accepts NOT_CHARGING because Expo only emits it when EXTRA_PLUGGED is nonzero", async () => {
    const device = await readPowerState(base, {
      getPowerState: async () => state(BATTERY_STATE.NOT_CHARGING, 0.1),
    });
    expect(fullDeriveMayRun(device)).toBe(true);
  });

  it("treats an unknown battery level conservatively", async () => {
    const device = await readPowerState(base, {
      getPowerState: async () => state(BATTERY_STATE.UNKNOWN, -1),
    });
    expect(device.batteryLevel).toBeUndefined();
    expect(fullDeriveMayRun(device)).toBe(false);
  });

  it("lets low-power mode veto full derivation", async () => {
    const device = await readPowerState(base, {
      getPowerState: async () => state(BATTERY_STATE.CHARGING, 1, true),
    });
    expect(fullDeriveMayRun(device)).toBe(false);
  });

  it("defers expensive work when the battery API fails", async () => {
    const device = await readPowerState(base, {
      getPowerState: async () => { throw new Error("battery unavailable"); },
    });
    expect(fullDeriveMayRun(device)).toBe(false);
  });
});
