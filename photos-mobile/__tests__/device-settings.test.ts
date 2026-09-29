import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVICE_SETTINGS,
  IMAGE_CEILING_CHOICES,
  parseDeviceSettings,
} from "../src/device-settings";

describe("device settings", () => {
  it("offer none, every standard photo size and the canonical", () => {
    expect(IMAGE_CEILING_CHOICES).toEqual([null, 320, 640, 1280, 2560, 4272]);
  });

  it("fall back to the defaults with nothing stored", () => {
    expect(parseDeviceSettings(null)).toEqual(DEFAULT_DEVICE_SETTINGS);
    expect(parseDeviceSettings("not json")).toEqual(DEFAULT_DEVICE_SETTINGS);
  });

  it("keep a valid stored value, including no ceiling at all", () => {
    expect(parseDeviceSettings(JSON.stringify({ imageCeiling: null, derivePhotoStandIns: false }))).toEqual({
      imageCeiling: null,
      derivePhotoStandIns: false,
    });
  });

  // A size this build no longer offers must not pin the device to it.
  it("drop a ceiling nobody can choose, field by field", () => {
    expect(parseDeviceSettings(JSON.stringify({ imageCeiling: 1000, derivePhotoStandIns: false }))).toEqual({
      imageCeiling: DEFAULT_DEVICE_SETTINGS.imageCeiling,
      derivePhotoStandIns: false,
    });
  });
});
