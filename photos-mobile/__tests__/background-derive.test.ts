import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { backgroundDerivePlan } from "../src/photos/background-derive";
import { FULL_DERIVE_CEILING_LONG_EDGE } from "../src/photos/derive-ladder";
import { createSqliteScanCursorStore, DERIVATION_CURSOR_TABLE, FULL_DERIVATION_CURSOR_TABLE } from "../src/work/scan-cursor";
import { createDeviceSettingsStore } from "../src/device-settings";

/**
 * Every background derivation — the pass on app open and both jobs in a
 * background window — asks `backgroundDerivePlan` first. Photo derivation is
 * always on, so only a device without a camera roll gets no plan.
 */
function node(withCameraRoll = true) {
  const db = new DatabaseSync(":memory:") as never;
  return {
    derivationCursor: withCameraRoll ? createSqliteScanCursorStore({ db, table: DERIVATION_CURSOR_TABLE }) : null,
    fullDerivationCursor: withCameraRoll ? createSqliteScanCursorStore({ db, table: FULL_DERIVATION_CURSOR_TABLE }) : null,
  };
}

describe("backgroundDerivePlan", () => {
  it("runs the cheap pass from its own cursor at the standing ceiling", () => {
    const n = node();
    expect(backgroundDerivePlan(n, "cheap", { maxRecords: 8 })).toEqual({ cursor: n.derivationCursor, maxRecords: 8 });
  });

  it("runs the full pass from its own cursor, to the canonical size, one record at a time", () => {
    const n = node();
    expect(backgroundDerivePlan(n, "full")).toEqual({
      cursor: n.fullDerivationCursor,
      ceilingLongEdge: FULL_DERIVE_CEILING_LONG_EDGE,
      maxRecords: 1,
    });
    expect(FULL_DERIVE_CEILING_LONG_EDGE).toBe(4272);
  });

  it("runs neither pass on a device that reads no camera roll", () => {
    expect(backgroundDerivePlan(node(false), "cheap")).toBeNull();
    expect(backgroundDerivePlan(node(false), "full")).toBeNull();
  });
});

describe("the device settings row", () => {
  // A restart opens a fresh store on the same database, which is all a
  // background window does too.
  it("survives a new store on the same database", () => {
    const db = new DatabaseSync(":memory:") as never;
    createDeviceSettingsStore({ db }).update({ standInCeilings: { image: 2560, video: 2000 } });
    expect(createDeviceSettingsStore({ db }).get()).toEqual({ standInCeilings: { image: 2560, video: 2000 } });
  });
});
