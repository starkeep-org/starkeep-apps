/**
 * Extracting a DNG's embedded JPEG preview (item 30).
 *
 * ## Why a preview and not the raw data
 *
 * Decoding raw sensor data means demosaicing, white balance, and a tone curve —
 * a colour-science pipeline whose output would not match what the camera
 * showed the photographer, and which nothing here has the standing to
 * second-guess. Every DNG already carries a JPEG the camera rendered itself,
 * usually at full resolution. Deriving the ladder from that preview gives
 * renditions that look like the photo the user took, for the cost of finding an
 * offset.
 *
 * ## The format, only as far as needed
 *
 * A DNG is a TIFF. That means a header naming a byte order and the offset of
 * the first IFD, then a chain of IFDs, each an array of 12-byte entries with a
 * pointer to the next. Previews live either in the main IFD or in the SubIFDs
 * that tag 0x014A points to. This walks them, keeps every entry that describes
 * a JPEG, and returns the largest by pixel area.
 *
 * **Largest by area, not the first found.** Cameras write more than one
 * preview: a 160x120 thumbnail for the EXIF block and a full-resolution render
 * beside it. Taking the first would silently build an entire ladder from a
 * thumbnail — every rung technically produced, every one useless, and nothing
 * in the output that looks like an error.
 *
 * A byte scan for `FFD8…FFD9` would be shorter and is the obvious shortcut. It
 * is also wrong: the marker pair occurs inside the raw data often enough to
 * match, and there is no way to tell a real preview from a coincidence without
 * the structure that says so.
 */

/** TIFF tags this needs. Everything else in the IFD is skipped. */
const TAG = {
  NEW_SUBFILE_TYPE: 0x00fe,
  IMAGE_WIDTH: 0x0100,
  IMAGE_LENGTH: 0x0101,
  COMPRESSION: 0x0103,
  STRIP_OFFSETS: 0x0111,
  STRIP_BYTE_COUNTS: 0x0117,
  SUB_IFDS: 0x014a,
  JPEG_INTERCHANGE_FORMAT: 0x0201,
  JPEG_INTERCHANGE_FORMAT_LENGTH: 0x0202,
} as const;

/** TIFF compression values that mean "these bytes are a JPEG". */
const JPEG_COMPRESSIONS = new Set([6, 7, 0x884c]);

export interface EmbeddedPreview {
  readonly offset: number;
  readonly length: number;
  readonly width: number;
  readonly height: number;
}

interface Reader {
  u16(at: number): number;
  u32(at: number): number;
  readonly length: number;
}

function reader(bytes: Uint8Array, littleEndian: boolean): Reader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    u16: (at) => view.getUint16(at, littleEndian),
    u32: (at) => view.getUint32(at, littleEndian),
    length: bytes.byteLength,
  };
}

/**
 * Every JPEG preview a DNG (or any TIFF) carries, largest first.
 *
 * Returns an empty array rather than throwing for anything that is not a TIFF,
 * or is truncated, or simply has no preview. A file with no preview is a real
 * and ordinary thing — some raw formats do not embed one — and it is not an
 * error, it is a reason to fall back.
 */
export function findEmbeddedPreviews(bytes: Uint8Array): EmbeddedPreview[] {
  if (bytes.byteLength < 8) return [];
  const byteOrder = (bytes[0]! << 8) | bytes[1]!;
  // "II" little-endian or "MM" big-endian. Anything else is not a TIFF.
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return [];
  const little = byteOrder === 0x4949;
  const r = reader(bytes, little);

  // 42 for TIFF; DNG keeps it. 43 is BigTIFF, whose IFDs are laid out
  // differently — not silently misparsed as TIFF, which would read garbage
  // offsets and could point anywhere in the file.
  if (r.u16(2) !== 42) return [];

  const previews: EmbeddedPreview[] = [];
  const seen = new Set<number>();
  const queue: number[] = [r.u32(4)];

  while (queue.length > 0) {
    const offset = queue.shift()!;
    // A malformed or hostile file can make IFDs point at each other. Without
    // this the walk never terminates.
    if (offset <= 0 || offset + 2 > r.length || seen.has(offset)) continue;
    seen.add(offset);
    if (seen.size > 64) break;

    const preview = readIfd(r, bytes, offset, queue, little);
    if (preview) previews.push(preview);
  }

  // Largest first: a camera writes a thumbnail *and* a full-resolution render,
  // and building a ladder from the thumbnail is the failure that looks like
  // success.
  return previews.sort((a, b) => b.width * b.height - a.width * a.height);
}

function readIfd(
  r: Reader,
  bytes: Uint8Array,
  ifdOffset: number,
  queue: number[],
  little: boolean,
): EmbeddedPreview | null {
  const count = r.u16(ifdOffset);
  const entriesEnd = ifdOffset + 2 + count * 12;
  if (entriesEnd + 4 > r.length) return null;

  let width = 0;
  let height = 0;
  let compression = 0;
  let stripOffset = 0;
  let stripLength = 0;
  let jpegOffset = 0;
  let jpegLength = 0;

  for (let i = 0; i < count; i += 1) {
    const entry = ifdOffset + 2 + i * 12;
    const tag = r.u16(entry);
    const type = r.u16(entry + 2);
    const valueCount = r.u32(entry + 4);
    const valueAt = entry + 8;

    switch (tag) {
      case TAG.IMAGE_WIDTH:
        width = scalar(r, type, valueAt);
        break;
      case TAG.IMAGE_LENGTH:
        height = scalar(r, type, valueAt);
        break;
      case TAG.COMPRESSION:
        compression = scalar(r, type, valueAt);
        break;
      case TAG.STRIP_OFFSETS:
        // Only single-strip previews are taken. A multi-strip JPEG would need
        // reassembly, and no camera writes its preview that way — accepting one
        // would mean returning the first strip as if it were the whole image.
        if (valueCount === 1) stripOffset = scalar(r, type, valueAt);
        break;
      case TAG.STRIP_BYTE_COUNTS:
        if (valueCount === 1) stripLength = scalar(r, type, valueAt);
        break;
      case TAG.JPEG_INTERCHANGE_FORMAT:
        jpegOffset = scalar(r, type, valueAt);
        break;
      case TAG.JPEG_INTERCHANGE_FORMAT_LENGTH:
        jpegLength = scalar(r, type, valueAt);
        break;
      case TAG.SUB_IFDS: {
        // Where the full-resolution preview usually lives, so failing to follow
        // these finds only the thumbnail.
        const inline = valueCount === 1;
        const base = inline ? valueAt : r.u32(valueAt);
        for (let n = 0; n < valueCount && n < 32; n += 1) {
          const at = inline ? base : base + n * 4;
          if (at + 4 <= r.length) queue.push(inline ? r.u32(at) : r.u32(at));
        }
        break;
      }
    }
  }

  const nextIfd = r.u32(entriesEnd);
  if (nextIfd > 0) queue.push(nextIfd);

  if (!JPEG_COMPRESSIONS.has(compression)) return null;
  const offset = jpegOffset || stripOffset;
  const length = jpegLength || stripLength;
  if (offset <= 0 || length <= 0 || offset + length > bytes.byteLength) return null;
  // Dimensions are required: they are how the largest preview is chosen, and a
  // preview of unknown size cannot be compared against one of known size.
  if (width <= 0 || height <= 0) return null;

  return { offset, length, width, height };
}

/** TIFF value types: 3 = SHORT, 4 = LONG. Others are not used by these tags. */
function scalar(r: Reader, type: number, at: number): number {
  return type === 3 ? r.u16(at) : r.u32(at);
}

/**
 * The bytes of the largest embedded preview, or `null` when there is none.
 *
 * The returned slice is validated to start with a JPEG SOI marker. A DNG whose
 * offsets point somewhere plausible but wrong would otherwise hand back
 * arbitrary bytes that fail much later, in a decoder, with a message about the
 * wrong thing.
 */
export function extractLargestPreview(bytes: Uint8Array): Uint8Array | null {
  for (const preview of findEmbeddedPreviews(bytes)) {
    const slice = bytes.subarray(preview.offset, preview.offset + preview.length);
    if (slice.byteLength >= 2 && slice[0] === 0xff && slice[1] === 0xd8) return slice;
  }
  return null;
}

/** Raw types whose ladder should be derived from an embedded preview. */
export const RAW_TYPES: readonly string[] = [
  "image/dng", "image/cr2", "image/cr3", "image/nef",
  "image/arw", "image/raf", "image/orf", "image/rw2",
];

export function isRawType(type: string): boolean {
  return RAW_TYPES.includes(type);
}
