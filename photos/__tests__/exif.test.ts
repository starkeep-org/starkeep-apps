/**
 * Tier-0 tests for the EXIF pipeline: the pure helpers in exif-generator and
 * the byte-level extraction in exif-reader. (Platform test plan §7b.)
 */
import { describe, it, expect } from "vitest";
import { extractExif } from "../src/photos-lib/metadata/exif-reader";
import {
  emptyExif,
  formatExposureTime,
  parseExifDate,
} from "../src/photos-lib/metadata/exif-generator";
import { tiffWithExif } from "./tiff-fixture";

describe("parseExifDate", () => {
  it("converts the EXIF colon-date format to ISO-ish local time", () => {
    expect(parseExifDate("2024:07:15 18:30:05")).toBe("2024-07-15T18:30:05");
  });

  it("passes Date instances through as ISO strings", () => {
    expect(parseExifDate(new Date("2024-07-15T18:30:05.000Z"))).toBe("2024-07-15T18:30:05.000Z");
  });

  it("rejects strings that are not EXIF dates", () => {
    expect(parseExifDate("2024-07-15 18:30:05")).toBeNull();
    expect(parseExifDate("yesterday")).toBeNull();
  });
});

describe("formatExposureTime", () => {
  it("renders sub-second exposures as reciprocals", () => {
    expect(formatExposureTime(1 / 250)).toBe("1/250s");
    expect(formatExposureTime(0.0125)).toBe("1/80s");
  });

  it("renders second-and-longer exposures directly", () => {
    expect(formatExposureTime(1)).toBe("1s");
    expect(formatExposureTime(30)).toBe("30s");
  });
});

describe("extractExif", () => {
  it("reads camera make/model/orientation from image bytes", async () => {
    const exif = await extractExif(tiffWithExif({ make: "Acme", model: "Snapper X" }));
    expect(exif.cameraMake).toBe("Acme");
    expect(exif.cameraModel).toBe("Snapper X");
    // exifr.parse() translates Orientation to a string ("Horizontal (normal)");
    // the reader now reads the raw numeric value via exifr.orientation(). The
    // fixture's IFD0 carries Orientation=1.
    expect(exif.orientation).toBe(1);
    // Fields the fixture doesn't carry stay null rather than garbage.
    expect(exif.iso).toBeNull();
    expect(exif.gpsLat).toBeNull();
  });

  it("returns empty fields for corrupt bytes instead of throwing", async () => {
    const exif = await extractExif(Buffer.from("definitely not an image"));
    expect(exif).toEqual(emptyExif());
  });
});
