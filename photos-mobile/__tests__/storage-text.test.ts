/**
 * The names Settings gives to what this device holds.
 */
import { describe, it, expect } from "vitest";
import { describeStorageGroup } from "../src/ui/storage-text";

describe("describeStorageGroup", () => {
  it("names previews, originals and the files every device keeps", () => {
    expect(describeStorageGroup("stand-in:image")).toBe("Photo previews");
    expect(describeStorageGroup("original:video")).toBe("Video originals");
    expect(describeStorageGroup("kept")).toBe("Other files, kept on every device");
  });
});
