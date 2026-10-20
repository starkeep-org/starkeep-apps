import { describe, expect, it } from "vitest";
import { photoInfoRows } from "../src/index";

describe("photoInfoRows", () => {
  it("lists every known fact in the panel's order", () => {
    const rows = photoInfoRows({
      originalFilename: "PXL_1.jpg",
      title: "Beach",
      width: 4000,
      height: 3000,
      mimeType: "image/jpeg",
      sizeBytes: 2 * 1024 * 1024,
      dateTaken: "2026-10-19T12:34:56.000Z",
      cameraMake: "Google",
      cameraModel: "Pixel 5",
      fNumber: 1.7,
      exposureTime: "1/120",
      iso: 100,
      lensModel: "Main",
      orientation: 6,
      gpsLat: 47.1234567,
      gpsLon: -122.7654321,
    });
    expect(rows.map((row) => row.label)).toEqual([
      "Filename",
      "Title",
      "Dimensions",
      "Megapixels",
      "MIME type",
      "File size",
      "Date taken",
      "Camera",
      "Aperture",
      "Exposure",
      "ISO",
      "Lens",
      "Orientation",
      "Location",
    ]);
    expect(rows.find((row) => row.label === "Date taken")?.value).toBe("2026-10-19 12:34:56");
    expect(rows.find((row) => row.label === "Location")?.value).toBe("47.12346, -122.76543");
  });

  it("leaves out every row whose value is unknown", () => {
    const rows = photoInfoRows({
      originalFilename: "PXL_2.jpg",
      width: null,
      height: null,
      mimeType: "image/jpeg",
      sizeBytes: 1000,
      dateTaken: null,
    });
    expect(rows.map((row) => row.label)).toEqual(["Filename", "MIME type", "File size"]);
  });
});
