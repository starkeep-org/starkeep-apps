/**
 * Tier-0 tests for the EXIF pipeline: the pure helpers in exif-generator and
 * the byte-level extraction in exif-reader. (Platform test plan §7b.)
 */
import { describe, it, expect } from "vitest";
import exifr from "exifr";
import { extractExif } from "../src/photos-lib/metadata/exif-reader";
import {
  ASSUMED_UTC_OFFSET_MINUTES,
  emptyExif,
  formatExposureTime,
  parseExifDate,
  parseExifOffsetMinutes,
} from "../src/photos-lib/metadata/exif-generator";
import { tiffWithExif } from "./tiff-fixture";

describe("parseExifOffsetMinutes", () => {
  it("reads both signs of an OffsetTime tag", () => {
    expect(parseExifOffsetMinutes("-04:00")).toBe(-240);
    expect(parseExifOffsetMinutes("+05:30")).toBe(330);
    expect(parseExifOffsetMinutes("+00:00")).toBe(0);
  });

  it("returns null for anything it cannot read", () => {
    // Null rather than zero, so the caller falls back to the assumed offset
    // instead of silently declaring the wall clock to be UTC.
    expect(parseExifOffsetMinutes("-4:00")).toBeNull();
    expect(parseExifOffsetMinutes("04:00")).toBeNull();
    expect(parseExifOffsetMinutes("-04:60")).toBeNull();
    expect(parseExifOffsetMinutes(undefined)).toBeNull();
    expect(parseExifOffsetMinutes(-240)).toBeNull();
  });
});

describe("parseExifDate", () => {
  it("applies the offset it is given and emits canonical UTC", () => {
    expect(parseExifDate("2024:07:15 18:30:05", -240)).toBe("2024-07-15T22:30:05.000Z");
    expect(parseExifDate("2024:07:15 18:30:05", 330)).toBe("2024-07-15T13:00:05.000Z");
    expect(parseExifDate("2024:07:15 18:30:05", 0)).toBe("2024-07-15T18:30:05.000Z");
  });

  it("crosses the day boundary rather than clamping", () => {
    expect(parseExifDate("2019:09:01 20:10:30", -240)).toBe("2019-09-02T00:10:30.000Z");
  });

  it("truncates a sub-second part to milliseconds", () => {
    expect(parseExifDate("2024:07:15 18:30:05.123456", 0)).toBe("2024-07-15T18:30:05.123Z");
  });

  it("rejects a Date rather than reading it in the process zone", () => {
    // The whole defect in one line: a `Date` here can only have been built by
    // `new Date(naive)`, which read the file's wall clock in whatever zone the
    // deriving machine runs in. An empty capture time is visible; a
    // zone-shifted one is not.
    expect(parseExifDate(new Date("2024-07-15T18:30:05.000Z"), -240)).toBeNull();
  });

  it("rejects strings that are not EXIF dates", () => {
    expect(parseExifDate("2024-07-15 18:30:05", 0)).toBeNull();
    expect(parseExifDate("yesterday", 0)).toBeNull();
  });

  it("rejects the all-zero date an unset camera clock writes", () => {
    expect(parseExifDate("0000:00:00 00:00:00", 0)).toBeNull();
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

  it("applies the file's own OffsetTimeOriginal", async () => {
    const bytes = tiffWithExif({
      dateTimeOriginal: "2026:04:04 10:29:21",
      offsetTimeOriginal: "-06:00",
    });
    expect((await extractExif(bytes)).dateTakenRaw).toBe("2026-04-04T16:29:21.000Z");
  });

  it("falls back to the assumed offset when the file names none", async () => {
    const bytes = tiffWithExif({ dateTimeOriginal: "2019:09:01 20:10:30" });
    expect(ASSUMED_UTC_OFFSET_MINUTES).toBe(-240);
    expect((await extractExif(bytes)).dateTakenRaw).toBe("2019-09-02T00:10:30.000Z");
  });

  it("reads the same instant whatever zone the deriving node runs in", async () => {
    // The property `captured_at` rests on: a derived column is a fact anyone
    // re-deriving from the same file reproduces. Both cases have to hold, and
    // before this the offset-bearing file was only right when the machine's
    // zone happened to match the tag.
    const withOffset = tiffWithExif({
      dateTimeOriginal: "2026:04:04 10:29:21",
      offsetTimeOriginal: "-06:00",
    });
    const without = tiffWithExif({ dateTimeOriginal: "2019:09:01 20:10:30" });
    const original = process.env.TZ;
    const seen: Record<string, [string | null, string | null]> = {};
    for (const zone of ["UTC", "America/Detroit", "Asia/Tokyo"]) {
      process.env.TZ = zone;
      seen[zone] = [
        (await extractExif(withOffset)).dateTakenRaw,
        (await extractExif(without)).dateTakenRaw,
      ];
    }
    process.env.TZ = original;
    expect(seen["UTC"]).toEqual(["2026-04-04T16:29:21.000Z", "2019-09-02T00:10:30.000Z"]);
    expect(seen["America/Detroit"]).toEqual(seen["UTC"]);
    expect(seen["Asia/Tokyo"]).toEqual(seen["UTC"]);
  });
});

describe("the exifr contract extractExif depends on", () => {
  // `reviveValues: false` is what keeps the date tags as raw strings, and
  // `parseExifDate` refuses a `Date` on purpose. If an exifr upgrade ever
  // revives them anyway, every capture time in the library would go null
  // silently — so the contract is pinned here rather than assumed.
  it("returns date and offset tags as strings under reviveValues: false", async () => {
    const bytes = tiffWithExif({
      dateTimeOriginal: "2026:04:04 10:29:21",
      offsetTimeOriginal: "-06:00",
    });
    const parsed = await exifr.parse(bytes, { reviveValues: false });
    expect(parsed.DateTimeOriginal).toBe("2026:04:04 10:29:21");
    expect(parsed.OffsetTimeOriginal).toBe("-06:00");
  });
});
