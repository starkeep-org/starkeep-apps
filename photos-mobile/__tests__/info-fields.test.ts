/**
 * The mapping from a record and its metadata row to the info sheet's fields.
 *
 * The row is built from the image category's own column list, so a column name
 * misspelled here — which would silently hide a row in the sheet — fails a test
 * rather than going unnoticed.
 */
import { describe, it, expect } from "vitest";
import {
  createDataRecord,
  createHLCClock,
  getCategory,
  type DataRecord,
  type MetadataRow,
} from "@starkeep/protocol-primitives";
import { deletePrompt, infoFields } from "../src/ui/info-fields";

const clock = createHLCClock({ nodeId: "phone" });
const record = createDataRecord(
  {
    type: "image/jpeg",
    originAppId: "photos",
    contentHash: "a".repeat(64),
    objectStorageKey: "shared/image/1",
    mimeType: "image/jpeg",
    sizeBytes: 2_400_000,
    originalFilename: "PXL_20261019.jpg",
  },
  clock,
);

const IMAGE_COLUMNS = getCategory("image")!.metadataColumns;
const CAPTURED_AT = "2026-10-19T14:03:00.000Z";

/** A metadata row with every image column filled with a value of its own type. */
function fullRow(): MetadataRow {
  const row: Record<string, unknown> = {};
  for (const { name, type } of IMAGE_COLUMNS) {
    row[name] =
      type === "integer" || type === "bigint"
        ? 3
        : type === "real"
          ? 1.8
          : type === "boolean"
            ? true
            : type === "timestamp"
              ? CAPTURED_AT
              : `${name} value`;
  }
  return row as MetadataRow;
}

describe("infoFields", () => {
  it("reads only columns the image category defines", () => {
    const read = new Set<string>();
    const row = new Proxy(fullRow(), {
      get(target, column: string) {
        read.add(column);
        return target[column];
      },
    });
    infoFields(record, row);
    const defined = new Set(IMAGE_COLUMNS.map((column) => column.name));
    expect([...read].filter((column) => !defined.has(column))).toEqual([]);
  });

  it("fills every field from a full image row", () => {
    const fields = infoFields(record, fullRow());
    expect(fields).toEqual({
      originalFilename: "PXL_20261019.jpg",
      width: 3,
      height: 3,
      mimeType: "image/jpeg",
      sizeBytes: 2_400_000,
      dateTaken: CAPTURED_AT,
      cameraMake: "camera_make value",
      cameraModel: "camera_model value",
      fNumber: 1.8,
      exposureTime: "exposure_time value",
      iso: 3,
      lensModel: "lens_model value",
      orientation: 3,
      gpsLat: 1.8,
      gpsLon: 1.8,
    });
  });

  it("reads a capture time given in milliseconds as the same ISO string", () => {
    const row = { ...fullRow(), captured_at: Date.parse(CAPTURED_AT) } as MetadataRow;
    expect(infoFields(record, row).dateTaken).toBe(CAPTURED_AT);
  });

  it("leaves out a column of the wrong type rather than printing it", () => {
    const row = {
      ...fullRow(),
      width: "4032",
      camera_make: 7,
      iso: Number.NaN,
      captured_at: "",
    } as unknown as MetadataRow;
    const fields = infoFields(record, row);
    expect(fields.width).toBeNull();
    expect(fields.cameraMake).toBeNull();
    expect(fields.iso).toBeNull();
    expect(fields.dateTaken).toBeNull();
  });

  it("keeps the record's own facts when there is no metadata row", () => {
    const fields = infoFields(record, null);
    expect(fields).toMatchObject({
      originalFilename: "PXL_20261019.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 2_400_000,
      width: null,
      dateTaken: null,
    });
  });
});

describe("deletePrompt", () => {
  it("names the item, and says where it goes and what Android asks next", () => {
    const { title, message } = deletePrompt({ originalFilename: "PXL_1.mp4" } as DataRecord);
    expect(title).toBe("Delete PXL_1.mp4?");
    expect(message).toContain("Drive's Trash");
    expect(message).toContain("Android then asks");
    expect(deletePrompt({ originalFilename: null } as DataRecord).title).toBe("Delete this item?");
  });
});
