/**
 * A photograph's record and metadata row, as the info rows are built from them.
 *
 * Apart from `PhotoInfoSheet` so the mapping is testable in Node: the sheet
 * imports React Native, and the mapping is where a misspelled column name would
 * silently drop a row.
 */

import type { PhotoInfoFields } from "@starkeep/photos-info";
import type { DataRecord, MetadataRow } from "@starkeep/protocol-primitives";

/**
 * The record and its metadata row, as the shared row builder reads them.
 *
 * Every column is read defensively, because a metadata row is whatever the node
 * that wrote it chose to fill in, and a column of the wrong type is better left
 * out than printed.
 */
export function infoFields(record: DataRecord, row: MetadataRow | null): PhotoInfoFields {
  const num = (column: string): number | null => {
    const value = row?.[column];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const text = (column: string): string | null => {
    const value = row?.[column];
    return typeof value === "string" && value !== "" ? value : null;
  };
  return {
    originalFilename: record.originalFilename,
    width: num("width"),
    height: num("height"),
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    // An ISO string from this phone's reader; a number of milliseconds would
    // be printed the same way.
    dateTaken:
      text("captured_at") ??
      (num("captured_at") !== null ? new Date(num("captured_at")!).toISOString() : null),
    cameraMake: text("camera_make"),
    cameraModel: text("camera_model"),
    fNumber: num("f_number"),
    exposureTime: text("exposure_time"),
    iso: num("iso"),
    lensModel: text("lens_model"),
    orientation: num("orientation"),
    gpsLat: num("gps_lat"),
    gpsLon: num("gps_lon"),
  };
}

/**
 * The confirmation the sheet's Delete shows, as a title and a message.
 *
 * The same promise Photos web makes: the item goes to Drive's Trash. The second
 * sentence is the phone's own, because only the phone holds a camera-roll file
 * to offer Android's trash for.
 */
export function deletePrompt(record: DataRecord): { readonly title: string; readonly message: string } {
  return {
    title: `Delete ${record.originalFilename ?? "this item"}?`,
    message:
      "It moves to Drive's Trash, where you can restore it for as long as your library keeps " +
      "deleted items. If its file is on this phone, Android then asks to move that file to the " +
      "phone's trash.",
  };
}
