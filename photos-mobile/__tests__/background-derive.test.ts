import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { backgroundDerivePlan } from "../src/photos/background-derive";
import { FULL_DERIVE_CEILING_LONG_EDGE } from "../src/photos/derive-ladder";
import { createSqliteScanCursorStore, DERIVATION_CURSOR_TABLE, FULL_DERIVATION_CURSOR_TABLE } from "../src/work/scan-cursor";
import { createDeviceSettingsStore, DEFAULT_DEVICE_SETTINGS, type DeviceSettings } from "../src/device-settings";

/**
 * The switch a person flips in the Storage section, where it takes effect.
 *
 * Every background derivation — the pass on app open and both jobs in a
 * background window — asks `backgroundDerivePlan` first, so this is the one
 * place the switch can stop them all.
 */
function node(settings: DeviceSettings, withCameraRoll = true) {
  const db = new DatabaseSync(":memory:") as never;
  return {
    derivationCursor: withCameraRoll ? createSqliteScanCursorStore({ db, table: DERIVATION_CURSOR_TABLE }) : null,
    fullDerivationCursor: withCameraRoll ? createSqliteScanCursorStore({ db, table: FULL_DERIVATION_CURSOR_TABLE }) : null,
    deviceSettings: () => settings,
  };
}

describe("backgroundDerivePlan", () => {
  const on = DEFAULT_DEVICE_SETTINGS;
  const off = { ...DEFAULT_DEVICE_SETTINGS, derivePhotoStandIns: false };

  it("runs the cheap pass from its own cursor at the standing ceiling", () => {
    const n = node(on);
    expect(backgroundDerivePlan(n, "cheap", { maxRecords: 8 })).toEqual({ cursor: n.derivationCursor, maxRecords: 8 });
  });

  it("runs the full pass from its own cursor, to the canonical size, one record at a time", () => {
    const n = node(on);
    expect(backgroundDerivePlan(n, "full")).toEqual({
      cursor: n.fullDerivationCursor,
      ceilingLongEdge: FULL_DERIVE_CEILING_LONG_EDGE,
      maxRecords: 1,
    });
    expect(FULL_DERIVE_CEILING_LONG_EDGE).toBe(4272);
  });

  it("runs neither pass with photo derivation off", () => {
    expect(backgroundDerivePlan(node(off), "cheap")).toBeNull();
    expect(backgroundDerivePlan(node(off), "full")).toBeNull();
  });

  it("runs neither pass on a device that reads no camera roll", () => {
    expect(backgroundDerivePlan(node(on, false), "cheap")).toBeNull();
    expect(backgroundDerivePlan(node(on, false), "full")).toBeNull();
  });
});

describe("the device settings row", () => {
  // A restart opens a fresh store on the same database, which is all a
  // background window does too.
  it("survives a new store on the same database", () => {
    const db = new DatabaseSync(":memory:") as never;
    createDeviceSettingsStore({ db }).update({ derivePhotoStandIns: false, imageCeiling: 2560 });
    expect(createDeviceSettingsStore({ db }).get()).toEqual({ imageCeiling: 2560, derivePhotoStandIns: false });
  });
});
