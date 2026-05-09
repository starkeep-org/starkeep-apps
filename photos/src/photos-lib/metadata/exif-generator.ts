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
