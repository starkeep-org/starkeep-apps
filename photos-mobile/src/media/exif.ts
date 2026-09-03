/**
 * The two EXIF facts a record needs, read from the bytes import already holds.
 *
 * ## Why a reader rather than a library
 *
 * `starkeep-apps/photos` uses `exifr` for this, and the obvious move was to
 * reuse it. Two things argue against it here, and the second is decisive.
 *
 * The first is proportion: `exifr` reads every tag in every segment of every
 * container it supports, and two tags are wanted. The second is Hermes.
 * `exifr`'s full build reaches for Node APIs and lazily loads its segment
 * parsers through dynamic `import()` of a computed specifier — the *exact*
 * construct that already cost this app a Metro resolver hack, because Hermes
 * cannot compile it and its mere presence in the module graph fails the whole
 * bundle whether or not anything calls it. See the kysely stub in
 * `metro.config.js`. Taking that risk for two integers, in the module that runs
 * on every imported photograph, is a bad trade.
 *
 * So this reads the tags directly. It is deliberately narrow: it walks IFD0 and
 * the Exif sub-IFD of a JPEG's APP1 segment and answers two questions. Anything
 * it does not understand — a HEIC, a truncated header, a byte order it does not
 * recognise — produces nulls rather than a throw, because the caller's job is
 * to import a photograph and an unreadable header is not a reason to fail one.
 *
 * ## Why the record carries this at all
 *
 * `captured_at` is what the library grid orders by. Without it the grid orders
 * by `created_at` — when the record entered the node — and import walks the
 * camera roll oldest-first, so every batch of old photographs took the top of
 * the grid and pushed recent ones off the bottom.
 *
 * `orientation` is what tells a consumer whether a record's stored `width` and
 * `height` swap when displayed. The phone writes those two from the media
 * store's `WIDTH`/`HEIGHT` columns, which Android does **not** correct for
 * orientation — unlike the legacy `Asset` API, which calls `maybeRotateAssetSize`.
 * Writing dimensions with no orientation beside them, which is what this app did
 * from `1ca50ea` until now, hands every consumer a landscape box for a portrait
 * photograph. The phone itself does not notice, because its tiles are square and
 * its viewer contains rather than measures; the web Photos app does, through
 * `justified-layout.ts` and `render-geometry.ts`.
 *
 * ## Deliberately only two tags
 *
 * Camera make, model, lens and GPS are all free once the header is parsed, and
 * none of them is written. Each is a column that starts syncing to every other
 * node the moment it is populated, and that deserves its own decision rather
 * than arriving as a side effect of wanting a capture time.
 */

/** What one photograph's header says, as far as this reader looks. */
export interface ImageExif {
  /**
   * `DateTimeOriginal`, normalized to ISO 8601, or null when absent.
   *
   * ISO because that is what `captured_at` already holds everywhere else — the
   * cloud importer writes `parseExifDate`'s output, and two spellings of a
   * timestamp in one column cannot be ordered against each other.
   *
   * **No timezone suffix**, matching the cloud. EXIF's `DateTimeOriginal` is
   * local time with no offset recorded, so appending `Z` would assert something
   * the file does not say. The values are compared against each other and never
   * against an instant, so a consistent absence beats an invented offset.
   */
  readonly capturedAt: string | null;
  /**
   * The EXIF orientation, 1 through 8, or null when absent or out of range.
   *
   * Range-checked rather than passed through, because a consumer reads this as
   * "do the axes swap" and a value outside 1–8 answers neither yes nor no. Null
   * says "nothing known", which is a state every consumer already handles.
   */
  readonly orientation: number | null;
  /**
   * `PixelXDimension` / `PixelYDimension`, the *stored* pixel dimensions.
   *
   * Preferred over the media store's `WIDTH`/`HEIGHT` when present, because they
   * come from the same header as {@link orientation} and therefore cannot
   * disagree with it. The media store remains the fallback: these tags live in
   * the Exif sub-IFD and plenty of files carry no sub-IFD at all.
   */
  readonly width: number | null;
  readonly height: number | null;
}

const NOTHING: ImageExif = { capturedAt: null, orientation: null, width: null, height: null };

/** TIFF tag numbers, in the two IFDs this reader walks. */
const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_CREATE_DATE = 0x9004;
const TAG_PIXEL_X = 0xa002;
const TAG_PIXEL_Y = 0xa003;

/**
 * How far into a file to look for the APP1 segment.
 *
 * EXIF is the first or second segment of a well-formed JPEG, so the header is
 * within a few kilobytes of the start. The bound matters because the caller may
 * hand over a Motion Photo, whose tail is a whole video: scanning that for a
 * marker that only ever appears near the front would mean walking tens of
 * megabytes to find nothing. The same argument `extractXmp` makes.
 */
const SEGMENT_SCAN_LIMIT = 256 * 1024;

/**
 * Read what this module understands from a JPEG's header.
 *
 * Never throws. Every malformed shape — a truncated segment, a bogus offset, a
 * byte order that is neither `II` nor `MM` — resolves to a null field, because
 * the caller is importing a photograph and a header it cannot read is not a
 * reason to refuse the file.
 */
export function readImageExif(bytes: Uint8Array): ImageExif {
  try {
    const app1 = findExifApp1(bytes);
    if (!app1) return NOTHING;
    return readTiff(bytes, app1);
  } catch {
    // A malformed header reads as an absent one. See the note above.
    return NOTHING;
  }
}

/**
 * Where the TIFF header inside the EXIF APP1 segment starts.
 *
 * Walks the segment chain properly rather than searching for the `Exif\0\0`
 * string, because that string can occur inside pixel data and a false positive
 * here produces confident nonsense — an offset into image data parses as a TIFF
 * header often enough to matter.
 */
function findExifApp1(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 4) return null;
  // SOI. Anything else is not a JPEG, and this reader claims nothing about
  // other containers.
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  const limit = Math.min(bytes.byteLength, SEGMENT_SCAN_LIMIT);
  let offset = 2;
  while (offset + 4 <= limit) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    // SOS: the entropy-coded image data starts here and segment structure ends.
    // Nothing past it is a header, so stopping is correct rather than cautious.
    if (marker === 0xda) return null;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return null;
    if (marker === 0xe1) {
      const payload = offset + 4;
      // `Exif\0\0`, then the TIFF header.
      if (
        payload + 6 <= limit &&
        bytes[payload] === 0x45 &&
        bytes[payload + 1] === 0x78 &&
        bytes[payload + 2] === 0x69 &&
        bytes[payload + 3] === 0x66 &&
        bytes[payload + 4] === 0x00
      ) {
        return payload + 6;
      }
      // An APP1 that is not EXIF — XMP lives in one of these — so keep walking.
    }
    offset += 2 + length;
  }
  return null;
}

function readTiff(bytes: Uint8Array, tiffStart: number): ImageExif {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tiffStart + 8 > bytes.byteLength) return NOTHING;

  const byteOrder = view.getUint16(tiffStart, false);
  // `II` little-endian, `MM` big-endian. Anything else is not a TIFF header,
  // which usually means the offset was wrong rather than the file being broken.
  const little = byteOrder === 0x4949;
  if (!little && byteOrder !== 0x4d4d) return NOTHING;
  if (view.getUint16(tiffStart + 2, little) !== 42) return NOTHING;

  const ifd0 = tiffStart + view.getUint32(tiffStart + 4, little);
  const zeroth = readIfd(view, bytes.byteLength, tiffStart, ifd0, little);
  const exifPointer = zeroth.get(TAG_EXIF_IFD_POINTER);
  const sub =
    typeof exifPointer === "number"
      ? readIfd(view, bytes.byteLength, tiffStart, tiffStart + exifPointer, little)
      : new Map<number, number | string>();

  const orientationRaw = zeroth.get(TAG_ORIENTATION);
  const orientation =
    typeof orientationRaw === "number" && orientationRaw >= 1 && orientationRaw <= 8
      ? orientationRaw
      : null;

  // `DateTimeOriginal` first, `CreateDate` second — the same precedence the
  // cloud importer's `extractExif` uses, so the two writers cannot disagree
  // about which tag a capture time comes from.
  const rawDate = sub.get(TAG_DATE_TIME_ORIGINAL) ?? sub.get(TAG_CREATE_DATE);
  const capturedAt = typeof rawDate === "string" ? parseExifDate(rawDate) : null;

  const width = positive(sub.get(TAG_PIXEL_X));
  const height = positive(sub.get(TAG_PIXEL_Y));

  return { capturedAt, orientation, width, height };
}

function positive(value: number | string | undefined): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

/** How many bytes one TIFF component of each type occupies. */
const TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

/**
 * One image file directory, as a map of tag number to value.
 *
 * Only the types this reader's six tags actually use are decoded — SHORT and
 * LONG for the numbers, ASCII for the date. A tag of any other type is skipped
 * rather than guessed at, which is why the result is sparse and every caller
 * treats a missing key as "not known".
 */
function readIfd(
  view: DataView,
  byteLength: number,
  tiffStart: number,
  ifdStart: number,
  little: boolean,
): Map<number, number | string> {
  const out = new Map<number, number | string>();
  if (ifdStart < tiffStart || ifdStart + 2 > byteLength) return out;

  const count = view.getUint16(ifdStart, little);
  for (let i = 0; i < count; i += 1) {
    const entry = ifdStart + 2 + i * 12;
    if (entry + 12 > byteLength) break;

    const tag = view.getUint16(entry, little);
    const type = view.getUint16(entry + 2, little);
    const components = view.getUint32(entry + 4, little);
    const size = TYPE_SIZES[type];
    if (!size) continue;

    const total = size * components;
    // Values of four bytes or fewer sit in the entry itself; anything larger is
    // an offset from the start of the TIFF header. Reading the inline case as an
    // offset is the classic way to end up parsing pixel data as a date.
    const valueAt = total <= 4 ? entry + 8 : tiffStart + view.getUint32(entry + 8, little);
    if (valueAt < 0 || valueAt + total > byteLength) continue;

    if (type === 2) {
      let text = "";
      for (let c = 0; c < components; c += 1) {
        const byte = view.getUint8(valueAt + c);
        // ASCII values are NUL-terminated, and the count includes the NUL.
        if (byte === 0) break;
        text += String.fromCharCode(byte);
      }
      out.set(tag, text);
    } else if (type === 3) {
      out.set(tag, view.getUint16(valueAt, little));
    } else if (type === 4 || type === 9) {
      out.set(tag, view.getUint32(valueAt, little));
    }
  }
  return out;
}

/**
 * EXIF's `YYYY:MM:DD HH:MM:SS` as ISO 8601.
 *
 * The same transformation `parseExifDate` performs in `starkeep-apps/photos`,
 * and deliberately the same output shape: `captured_at` is one column that both
 * importers write and two spellings of a timestamp in it cannot be ordered
 * against each other.
 *
 * A camera that has never had its clock set writes all zeroes, which parses
 * structurally and describes no moment. Rejected, because sorted into a library
 * it would claim to be the oldest photograph ever taken.
 */
export function parseExifDate(value: string): string | null {
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  if (year === "0000" || month === "00" || day === "00") return null;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}
