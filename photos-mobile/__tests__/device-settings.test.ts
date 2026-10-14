import { describe, expect, it } from "vitest";
import { DEFAULT_SYNC_DOWN_CEILINGS } from "@starkeep/protocol-primitives";
import { ceilingsOf, DEFAULT_DEVICE_SETTINGS, parseDeviceSettings } from "../src/device-settings";

describe("device settings", () => {
  it("fall back to the phone defaults with nothing stored", () => {
    expect(parseDeviceSettings(null)).toEqual(DEFAULT_DEVICE_SETTINGS);
    expect(parseDeviceSettings("not json")).toEqual(DEFAULT_DEVICE_SETTINGS);
    expect(ceilingsOf(DEFAULT_DEVICE_SETTINGS)).toEqual(DEFAULT_SYNC_DOWN_CEILINGS.phone);
  });

  it("keep valid stored ceilings, including none at all, per category", () => {
    const settings = parseDeviceSettings(JSON.stringify({ standInCeilings: { image: null, video: 2000 } }));
    expect(settings).toEqual({ standInCeilings: { image: null, video: 2000 } });
    expect(ceilingsOf(settings)).toEqual({ image: null, video: 2000 });
  });

  it("leave a category nobody set on the phone default", () => {
    const settings = parseDeviceSettings(JSON.stringify({ standInCeilings: { video: 4800 } }));
    expect(ceilingsOf(settings)).toEqual({ image: DEFAULT_SYNC_DOWN_CEILINGS.phone.image, video: 4800 });
  });

  // The same check the desktop applies to `config.json`: a malformed value
  // falls back to the default rather than being trusted.
  it("drop a malformed ceiling and an unknown category", () => {
    const settings = parseDeviceSettings(JSON.stringify({ standInCeilings: { image: -5, audio: 10, video: 2000 } }));
    expect(settings).toEqual({ standInCeilings: { video: 2000 } });
  });

  it("ignore a row from the build that stored a single photo ceiling", () => {
    expect(parseDeviceSettings(JSON.stringify({ imageCeiling: 2560, derivePhotoStandIns: false }))).toEqual(
      DEFAULT_DEVICE_SETTINGS,
    );
  });
});
