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

/**
 * The UTC offset a capture time is read in when the file names none.
 *
 * EXIF's `DateTimeOriginal` is a naive wall clock by specification, and the
 * zone lives in the separate `OffsetTime*` tags that EXIF 2.31 added in 2016.
 * Plenty of files carry no offset tag at all, so something has to stand in, and
 * only three properties are actually required of the stand-in.
 *
 * It must be a **constant**. `captured_at` is a derived column — a fact anyone
 * re-deriving from the same file reproduces — and that is what lets a metadata
 * row ride the sync wire as a clockless passenger on its record. Reading the
 * naive value in the *deriving machine's* zone breaks the property outright:
 * the same bytes yield 20:10:30Z on a UTC Lambda and 00:10:30Z on this laptop,
 * and two nodes then hold genuinely conflicting truth rather than different
 * amounts of it.
 *
 * It must be **wrong in a bounded, legible way** rather than unpredictably.
 * A fixed offset misdates a photograph taken elsewhere by the difference
 * between the two zones, which is at worst a day boundary; the reader's zone
 * misdates it by whatever machine happened to run derivation.
 *
 * It must be **replaceable**. This is US Eastern daylight time, which is where
 * this library's photographs were mostly taken, and it belongs in app
 * configuration rather than in a constant. It is not configurable yet, and the
 * day it becomes configurable the constancy argument above has to be made again
 * — two nodes configured differently reproduce exactly the divergence this
 * constant exists to prevent.
 */
export const ASSUMED_UTC_OFFSET_MINUTES = -4 * 60;

/** `±HH:MM`, as EXIF's `OffsetTime*` tags spell an offset. */
const EXIF_OFFSET_RE = /^([+-])(\d{2}):(\d{2})$/;

/**
 * One `OffsetTime*` tag as minutes east of UTC, or null for anything unusable.
 *
 * Null rather than zero for an unreadable tag, so the caller falls back to
 * {@link ASSUMED_UTC_OFFSET_MINUTES} rather than silently declaring the wall
 * clock to be UTC.
 */
export function parseExifOffsetMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = EXIF_OFFSET_RE.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  if (Number(match[3]) > 59) return null;
  return match[1] === "-" ? -minutes : minutes;
}

/** EXIF's `YYYY:MM:DD HH:MM:SS`, with the sub-second part some writers add. */
const EXIF_DATE_RE =
  /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

/**
 * EXIF's naive wall clock plus a UTC offset, as a canonical ISO-8601 instant.
 *
 * **Only the raw string form is accepted, and that is the point.** `exifr`
 * revives a date tag by handing the naive string to `new Date(...)`, which
 * JavaScript reads in the *process* zone — and it does this whether or not the
 * file carries an `OffsetTime*` tag, so its `Date` is never the instant the
 * file describes except by coincidence. `extractExif` therefore parses with
 * `reviveValues: false` and passes the untouched string here, and a `Date`
 * arriving at this function means that contract has broken. Returning null
 * leaves `captured_at` empty, which is visible; reading the `Date`'s local
 * components would silently restore the defect this function exists to remove.
 *
 * A camera whose clock has never been set writes all zeroes, which parses
 * structurally and describes no moment. Rejected, because sorted into a library
 * it would claim to be the oldest photograph ever taken.
 */
export function parseExifDate(value: unknown, offsetMinutes: number): string | null {
  if (typeof value !== "string") return null;
  const match = EXIF_DATE_RE.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  if (year === "0000" || month === "00" || day === "00") return null;
  const millis =
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      // Truncated to milliseconds rather than rounded, so the value only ever
      // moves toward the instant the canonical form can hold and never past it.
      Number(fraction.padEnd(3, "0").slice(0, 3)),
    ) -
    offsetMinutes * 60_000;
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toISOString();
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
