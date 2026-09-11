import exifr from "exifr";
import {
  ASSUMED_UTC_OFFSET_MINUTES,
  emptyExif,
  formatExposureTime,
  parseExifDate,
  parseExifOffsetMinutes,
  type ExifFields,
} from "./exif-generator";

/**
 * Extract EXIF + GPS fields from a JPEG/HEIC/TIFF image's bytes. Any
 * missing tags fall back to null. The buffer is not modified. Errors
 * (corrupt files, unsupported formats) are swallowed and produce an
 * empty result — the upload still succeeds, just without EXIF metadata.
 */
export async function extractExif(bytes: Uint8Array | Buffer): Promise<ExifFields> {
  try {
    // `reviveValues: false` is load-bearing, not a micro-optimization. Left on,
    // exifr turns every date tag into a `Date` by handing the naive EXIF string
    // to `new Date(...)`, which reads it in the *process* zone — and it does so
    // whether or not the file carries an `OffsetTime*` tag, so the offset the
    // camera recorded is discarded and the deriving machine's zone is applied
    // in its place. Probed on a stored Pixel frame: `2026:04:04 10:29:21` with
    // `OffsetTimeOriginal = "-06:00"` revives as `14:29:21Z` under
    // America/Detroit and `10:29:21Z` under UTC, and the instant the file
    // actually describes is `16:29:21Z`.
    //
    // Off, the date tags arrive as their raw strings and the zone becomes this
    // module's decision rather than the runtime's. It changes nothing else this
    // reader uses — make, model, f-number, exposure, ISO, lens and the computed
    // latitude/longitude are byte-identical either way.
    const parsed = await exifr.parse(bytes as Uint8Array, { reviveValues: false });
    if (!parsed) return emptyExif();

    const dateTakenRaw =
      parsed.DateTimeOriginal
        ? parseExifDate(parsed.DateTimeOriginal, offsetFor(parsed, "OffsetTimeOriginal"))
        : parsed.CreateDate
          ? parseExifDate(parsed.CreateDate, offsetFor(parsed, "OffsetTimeDigitized"))
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

/**
 * The offset tag EXIF 2.31 pairs with one date tag, or the best stand-in.
 *
 * The paired tag is asked for first because that is the one the specification
 * says describes this date. The other two follow because a writer that records
 * a zone at all almost always records the same zone in all three, and a sibling
 * tag is a fact the file states — which
 * {@link ASSUMED_UTC_OFFSET_MINUTES} is not.
 *
 * GPS is deliberately not consulted. A coordinate plus a date does determine a
 * zone, but only through a boundary database that changes under us, and a
 * derived column may not depend on which version of that database a node
 * carries.
 */
function offsetFor(
  parsed: Record<string, unknown>,
  preferred: "OffsetTimeOriginal" | "OffsetTimeDigitized",
): number {
  const candidates = [preferred, "OffsetTimeOriginal", "OffsetTime", "OffsetTimeDigitized"];
  for (const tag of candidates) {
    const minutes = parseExifOffsetMinutes(parsed[tag]);
    if (minutes !== null) return minutes;
  }
  return ASSUMED_UTC_OFFSET_MINUTES;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type { ExifFields };
