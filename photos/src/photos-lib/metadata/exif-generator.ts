// EXIF fields are now stored directly in DataRecord.content.
// The parsing logic below can be used by upload handlers that have access
// to the image bytes and an EXIF library (e.g. exifr).
export const EXIF_GENERATOR_ID = "@photos/app:exif";

export interface ExifFields {
  dateTakenRaw: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  fNumber: number | null;
  exposureTime: string | null;
  iso: number | null;
  lensModel: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
  orientation: number | null;
}

export function emptyExif(): ExifFields {
  return {
    dateTakenRaw: null,
    cameraMake: null,
    cameraModel: null,
    fNumber: null,
    exposureTime: null,
    iso: null,
    lensModel: null,
    gpsLat: null,
    gpsLon: null,
    orientation: null,
  };
}

export function parseExifDate(value: string | Date): string | null {
  if (value instanceof Date) return value.toISOString();
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
}

export function formatExposureTime(seconds: number): string {
  if (seconds >= 1) return `${seconds}s`;
  const reciprocal = Math.round(1 / seconds);
  return `1/${reciprocal}s`;
}

/**
 * One `ExifFields` mapped onto the `image` metadata columns.
 *
 * Two callers write these facts — derivation and the viewer's backfill — and
 * both must agree on the column names and on `exif_present`, so the mapping
 * lives here rather than in either of them.
 *
 * Null fields are omitted, because the metadata write is a column-wise upsert
 * and sending a null would overwrite a value somebody may have corrected.
 * `exif_present` is always sent: it is the record of having looked, and a file
 * that carries nothing is exactly the case it exists to remember.
 */
export function exifColumnFacts(exif: ExifFields): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    captured_at: exif.dateTakenRaw,
    camera_make: exif.cameraMake,
    camera_model: exif.cameraModel,
    f_number: exif.fNumber,
    exposure_time: exif.exposureTime,
    iso: exif.iso,
    lens_model: exif.lensModel,
    gps_lat: exif.gpsLat,
    gps_lon: exif.gpsLon,
    orientation: exif.orientation,
  };
  const facts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mapped)) {
    if (value !== null && value !== undefined) facts[key] = value;
  }
  facts.exif_present = Object.keys(facts).length > 0;
  return facts;
}
