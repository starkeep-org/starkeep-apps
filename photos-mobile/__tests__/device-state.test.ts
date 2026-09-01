/**
 * Reading the phone's real conditions.
 *
 * The assertions worth having here are the conservative ones. Every fallback in
 * `device-state.ts` defers work rather than performing it on an unknown device,
 * and deferring costs one window while guessing wrong costs a person money —
 * so the failure directions are asserted rather than left to inspection.
 */
import { describe, it, expect } from "vitest";
import { readDeviceState, STORAGE_LOW_FRACTION } from "../src/work/device-state";

const power = { getPowerState: async () => ({ batteryLevel: 0.8, batteryState: 1, lowPowerMode: false }) };
const fullDisk = { readDisk: () => ({ availableBytes: 50_000, totalBytes: 100_000 }) };

const read = (type: string | undefined, over: Partial<Parameters<typeof readDeviceState>[0]> = {}) =>
  readDeviceState({
    network: { getNetworkState: async () => ({ type, isConnected: true, isInternetReachable: true }) },
    disk: fullDisk,
    power,
    ...over,
  });

describe("network", () => {
  it("treats Wi-Fi and Ethernet as unmetered", async () => {
    expect((await read("WIFI")).isUnmetered).toBe(true);
    expect((await read("ETHERNET")).isUnmetered).toBe(true);
  });

  it("treats cellular as metered, which is what stops originals going over a data plan", async () => {
    const state = await read("CELLULAR");
    expect(state.hasNetwork).toBe(true);
    expect(state.isUnmetered).toBe(false);
  });

  it("treats an unknown connection type as metered rather than guessing in the expensive direction", async () => {
    expect((await read(undefined)).isUnmetered).toBe(false);
    expect((await read("OTHER")).isUnmetered).toBe(false);
  });

  it("reports no network when the internet is unreachable, even on a connected Wi-Fi", async () => {
    // A captive portal is a connected network that cannot reach the cloud, and
    // a round against it spends a whole window finding out.
    const state = await readDeviceState({
      network: {
        getNetworkState: async () => ({ type: "WIFI", isConnected: true, isInternetReachable: false }),
      },
      disk: fullDisk,
      power,
    });
    expect(state.hasNetwork).toBe(false);
    expect(state.isUnmetered).toBe(false);
  });

  it("falls back to offline when the network module throws", async () => {
    const state = await readDeviceState({
      network: {
        getNetworkState: () => {
          throw new Error("no module");
        },
      },
      disk: fullDisk,
      power,
    });
    expect(state.hasNetwork).toBe(false);
    expect(state.isUnmetered).toBe(false);
  });
});

describe("storage", () => {
  it("is low below the threshold and fine above it", async () => {
    const at = (available: number) =>
      readDeviceState({
        network: { getNetworkState: async () => ({ type: "WIFI", isInternetReachable: true }) },
        disk: { readDisk: () => ({ availableBytes: available, totalBytes: 1000 }) },
        power,
      });
    expect((await at(STORAGE_LOW_FRACTION * 1000 - 1)).isStorageLow).toBe(true);
    expect((await at(STORAGE_LOW_FRACTION * 1000 + 1)).isStorageLow).toBe(false);
  });

  it("treats a zero total as a failed reading rather than a full disk", async () => {
    // Guarded because the opposite reading would make every job that requires
    // storage refuse to run on a device whose volume simply could not be read.
    const state = await readDeviceState({
      network: { getNetworkState: async () => ({ type: "WIFI", isInternetReachable: true }) },
      disk: { readDisk: () => ({ availableBytes: 0, totalBytes: 0 }) },
      power,
    });
    expect(state.isStorageLow).toBe(true);
  });
});

describe("power", () => {
  it("carries the battery reading through, which is what gates the expensive rungs", async () => {
    const state = await read("WIFI");
    expect(state.batteryLevel).toBe(0.8);
    expect(state.isLowPowerMode).toBe(false);
  });
});
