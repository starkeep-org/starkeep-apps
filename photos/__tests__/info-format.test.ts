/**
 * Tests for the photo Info panel's pure formatting helpers — the extra
 * metadata rows (megapixels, EXIF orientation label) added alongside the lazy
 * metadata work.
 */
import { describe, it, expect } from "vitest";
import { formatBytes, formatMegapixels, formatOrientation } from "../src/photos-ui/components/viewer/info-format";

describe("formatBytes", () => {
  it("scales across B / KB / MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("formatMegapixels", () => {
  it("computes megapixels from dimensions", () => {
    expect(formatMegapixels(4000, 3000)).toBe("12.0 MP");
    expect(formatMegapixels(1920, 1080)).toBe("2.1 MP");
  });

  it("returns null for missing dimensions so the row is hidden", () => {
    expect(formatMegapixels(0, 0)).toBeNull();
    expect(formatMegapixels(4000, 0)).toBeNull();
    expect(formatMegapixels(-1, 100)).toBeNull();
  });
});

describe("formatOrientation", () => {
  it("labels the standard EXIF orientation values", () => {
    expect(formatOrientation(1)).toBe("Normal");
    expect(formatOrientation(6)).toBe("Rotated 90° CW");
    expect(formatOrientation(8)).toBe("Rotated 90° CCW");
  });

  it("falls back to a labelled value for out-of-range orientations", () => {
    expect(formatOrientation(9)).toBe("Unknown (9)");
    expect(formatOrientation(0)).toBe("Unknown (0)");
  });
});
