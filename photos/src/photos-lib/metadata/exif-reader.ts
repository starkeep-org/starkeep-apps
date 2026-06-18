import exifr from "exifr";
import { emptyExif, formatExposureTime, parseExifDate, type ExifFields } from "./exif-generator";

/**
 * Extract EXIF + GPS fields from a JPEG/HEIC/TIFF image's bytes. Any
 * missing tags fall back to null. The buffer is not modified. Errors
 * (corrupt files, unsupported formats) are swallowed and produce an
 * empty result — the upload still succeeds, just without EXIF metadata.
 */
export async function extractExif(bytes: Uint8Array | Buffer): Promise<ExifFields> {
  try {
    const parsed = await exifr.parse(bytes as Uint8Array);
    if (!parsed) return emptyExif();

    const dateTakenRaw =
      parsed.DateTimeOriginal
        ? parseExifDate(parsed.DateTimeOriginal)
        : parsed.CreateDate
          ? parseExifDate(parsed.CreateDate)
          : null;

    const exposureTime =
      typeof parsed.ExposureTime === "number"
        ? formatExposureTime(parsed.ExposureTime)
        : null;

    // exifr.parse() with default options *translates* tag values, so
    // parsed.Orientation comes back as a human string ("Horizontal (normal)")
    // and never a number — numberOrNull(parsed.Orientation) was always null.
    // exifr.orientation() returns the raw numeric 1–8 value instead. A separate
    // pass keeps the translated values (Make/Model/exposure date) the other
    // fields rely on untouched.
    let orientation: number | null = null;
    try {
      orientation = numberOrNull(await exifr.orientation(bytes as Uint8Array));
    } catch {
      orientation = null;
    }

    return {
      dateTakenRaw,
      cameraMake: stringOrNull(parsed.Make),
      cameraModel: stringOrNull(parsed.Model),
      fNumber: numberOrNull(parsed.FNumber),
      exposureTime,
      iso: numberOrNull(parsed.ISO),
      lensModel: stringOrNull(parsed.LensModel),
      gpsLat: numberOrNull(parsed.latitude),
      gpsLon: numberOrNull(parsed.longitude),
      orientation,
    };
  } catch {
    return emptyExif();
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type { ExifFields };
