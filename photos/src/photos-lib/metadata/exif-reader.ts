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
      orientation: numberOrNull(parsed.Orientation),
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
