/**
 * A JPEG with a real EXIF header, built byte by byte.
 *
 * Built rather than checked in as a binary fixture, because the thing under
 * test is a byte-level reader and a fixture nobody can read is a fixture nobody
 * can vary. Every case that matters here — a missing tag, a big-endian header, a
 * value that sits inline versus one that sits at an offset — is a parameter of
 * this function rather than another opaque file.
 */

interface ExifFixture {
  /** `DateTimeOriginal`, in EXIF's own `YYYY:MM:DD HH:MM:SS` spelling. */
  readonly dateTimeOriginal?: string;
  readonly orientation?: number;
  readonly pixelWidth?: number;
  readonly pixelHeight?: number;
  /** Big-endian (`MM`) rather than little-endian (`II`). */
  readonly bigEndian?: boolean;
  /**
   * Put an unrelated APP1 before the EXIF one.
   *
   * XMP lives in exactly such a segment, and a Motion Photo always has one — so
   * a reader that takes the first APP1 it meets finds the wrong segment on the
   * most common kind of photograph this app imports.
   */
  readonly xmpFirst?: boolean;
}

const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_POINTER = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_PIXEL_X = 0xa002;
const TAG_PIXEL_Y = 0xa003;

const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;

/** One TIFF entry, before its value has been placed. */
interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Written into the entry's value slot, or used as the offset when large. */
  inline?: number;
  bytes?: Uint8Array;
}

function asciiValue(text: string): Uint8Array {
  // NUL-terminated, and the count includes the NUL — which is what makes a
  // reader that trusts `count` blindly emit a trailing zero byte.
  const out = new Uint8Array(text.length + 1);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
  return out;
}

export function jpegWithExif(fixture: ExifFixture = {}): Uint8Array {
  const little = !fixture.bigEndian;

  const ifd0: Entry[] = [];
  if (fixture.orientation !== undefined) {
    ifd0.push({ tag: TAG_ORIENTATION, type: TYPE_SHORT, count: 1, inline: fixture.orientation });
  }

  const exifIfd: Entry[] = [];
  if (fixture.dateTimeOriginal !== undefined) {
    const bytes = asciiValue(fixture.dateTimeOriginal);
    exifIfd.push({
      tag: TAG_DATE_TIME_ORIGINAL,
      type: TYPE_ASCII,
      count: bytes.length,
      bytes,
    });
  }
  if (fixture.pixelWidth !== undefined) {
    exifIfd.push({ tag: TAG_PIXEL_X, type: TYPE_LONG, count: 1, inline: fixture.pixelWidth });
  }
  if (fixture.pixelHeight !== undefined) {
    exifIfd.push({ tag: TAG_PIXEL_Y, type: TYPE_LONG, count: 1, inline: fixture.pixelHeight });
  }

  // IFD0 carries the pointer to the sub-IFD whenever there is one to point at.
  const withPointer = exifIfd.length > 0;
  const ifd0Count = ifd0.length + (withPointer ? 1 : 0);

  // Layout, all offsets relative to the start of the TIFF header.
  const ifd0At = 8;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifAt = ifd0At + ifd0Size;
  const exifSize = withPointer ? 2 + exifIfd.length * 12 + 4 : 0;
  const dataAt = exifAt + exifSize;

  const overflow = [...ifd0, ...exifIfd].filter((e) => e.bytes && e.bytes.length > 4);
  const dataSize = overflow.reduce((sum, e) => sum + e.bytes!.length, 0);

  const tiff = new Uint8Array(dataAt + dataSize);
  const view = new DataView(tiff.buffer);

  view.setUint16(0, little ? 0x4949 : 0x4d4d, false);
  view.setUint16(2, 42, little);
  view.setUint32(4, ifd0At, little);

  let dataCursor = dataAt;
  const writeEntry = (at: number, entry: Entry): void => {
    view.setUint16(at, entry.tag, little);
    view.setUint16(at + 2, entry.type, little);
    view.setUint32(at + 4, entry.count, little);
    if (entry.bytes) {
      if (entry.bytes.length > 4) {
        view.setUint32(at + 8, dataCursor, little);
        tiff.set(entry.bytes, dataCursor);
        dataCursor += entry.bytes.length;
      } else {
        // Four bytes or fewer live in the entry itself. A reader that treats
        // this as an offset parses pixel data as a value.
        tiff.set(entry.bytes, at + 8);
      }
      return;
    }
    const value = entry.inline ?? 0;
    // A SHORT occupies the *first* two bytes of the four-byte slot, which is
    // the detail a reader gets wrong by reading the slot as a LONG.
    if (entry.type === TYPE_SHORT) view.setUint16(at + 8, value, little);
    else view.setUint32(at + 8, value, little);
  };

  let at = ifd0At;
  view.setUint16(at, ifd0Count, little);
  at += 2;
  for (const entry of ifd0) {
    writeEntry(at, entry);
    at += 12;
  }
  if (withPointer) {
    writeEntry(at, { tag: TAG_EXIF_POINTER, type: TYPE_LONG, count: 1, inline: exifAt });
    at += 12;
  }
  view.setUint32(at, 0, little);

  if (withPointer) {
    at = exifAt;
    view.setUint16(at, exifIfd.length, little);
    at += 2;
    for (const entry of exifIfd) {
      writeEntry(at, entry);
      at += 12;
    }
    view.setUint32(at, 0, little);
  }

  return assembleJpeg(tiff, fixture.xmpFirst ?? false);
}

/** Wrap a TIFF block in the JPEG segments a camera would write around it. */
function assembleJpeg(tiff: Uint8Array, xmpFirst: boolean): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];

  if (xmpFirst) {
    const xmp = asciiValue("http://ns.adobe.com/xap/1.0/");
    const payload = new Uint8Array(xmp.length + 32);
    payload.set(xmp, 0);
    parts.push(app1(payload));
  }

  const exifHeader = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
  const payload = new Uint8Array(exifHeader.length + tiff.length);
  payload.set(exifHeader, 0);
  payload.set(tiff, exifHeader.length);
  parts.push(app1(payload));

  // A body, so the file is not just a header — and an EOI, so it is a whole
  // JPEG. `readImageExif` stops at SOS, and a file with none would let a broken
  // walker run off the end and still pass.
  parts.push(new Uint8Array([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));
  parts.push(new Uint8Array(64));
  parts.push(new Uint8Array([0xff, 0xd9]));

  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function app1(payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  const out = new Uint8Array(payload.length + 4);
  out[0] = 0xff;
  out[1] = 0xe1;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  out.set(payload, 4);
  return out;
}
