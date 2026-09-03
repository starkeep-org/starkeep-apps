/**
 * Reading the two facts a record needs out of a photograph's header.
 *
 * Every case is a shape a real camera writes. The reader is deliberately narrow
 * — two tags and a pair of dimensions — so the interesting failures are not
 * "which tag" but "did the walk land where it thought it did": an inline value
 * read as an offset, a SHORT read as a LONG, the wrong APP1 segment, a byte
 * order taken for granted. Each of those produces confident nonsense rather than
 * an error, which is why they are tested one at a time.
 */

import { describe, it, expect } from "vitest";
import { readImageExif, parseExifDate } from "../src/media/exif";
import { jpegWithExif } from "./helpers/jpeg-exif";

describe("readImageExif", () => {
  it("reads the capture time and the orientation a camera wrote", () => {
    const exif = readImageExif(
      jpegWithExif({ dateTimeOriginal: "2026:07:06 14:53:56", orientation: 6 }),
    );
    expect(exif.capturedAt).toBe("2026-07-06T14:53:56");
    expect(exif.orientation).toBe(6);
  });

  it("reads a big-endian header", () => {
    // `MM` is what a good many cameras write, and a reader that assumes `II`
    // does not fail — it reads every multi-byte value backwards and reports an
    // orientation of 1536 and a date at a nonsense offset.
    const exif = readImageExif(
      jpegWithExif({ dateTimeOriginal: "2026:01:02 03:04:05", orientation: 8, bigEndian: true }),
    );
    expect(exif.capturedAt).toBe("2026-01-02T03:04:05");
    expect(exif.orientation).toBe(8);
  });

  it("finds the EXIF segment behind an XMP one", () => {
    // Every Motion Photo has an XMP APP1, and on this app's own handset that is
    // most of the camera roll. A reader that takes the first APP1 it meets finds
    // XMP and reports a photograph with no header at all.
    const exif = readImageExif(
      jpegWithExif({ dateTimeOriginal: "2026:03:04 05:06:07", orientation: 1, xmpFirst: true }),
    );
    expect(exif.capturedAt).toBe("2026-03-04T05:06:07");
    expect(exif.orientation).toBe(1);
  });

  it("reads the stored pixel dimensions when the header carries them", () => {
    const exif = readImageExif(jpegWithExif({ pixelWidth: 4032, pixelHeight: 3024 }));
    expect(exif.width).toBe(4032);
    expect(exif.height).toBe(3024);
  });

  it("answers null for each tag the header does not carry", () => {
    // A screenshot: a real JPEG with a real header and none of what is wanted.
    const exif = readImageExif(jpegWithExif({ orientation: 1 }));
    expect(exif.capturedAt).toBeNull();
    expect(exif.width).toBeNull();
    expect(exif.height).toBeNull();
    expect(exif.orientation).toBe(1);
  });

  it("rejects an orientation outside the range that means anything", () => {
    // A consumer reads this as "do the axes swap", and a value outside 1–8
    // answers neither yes nor no. Null is a state every consumer handles.
    expect(readImageExif(jpegWithExif({ orientation: 0 })).orientation).toBeNull();
    expect(readImageExif(jpegWithExif({ orientation: 99 })).orientation).toBeNull();
  });

  it("answers nothing, rather than throwing, for bytes it cannot read", () => {
    const nothing = { capturedAt: null, orientation: null, width: null, height: null };
    // Not a JPEG at all.
    expect(readImageExif(new Uint8Array([1, 2, 3, 4]))).toEqual(nothing);
    // Empty.
    expect(readImageExif(new Uint8Array(0))).toEqual(nothing);
    // A JPEG with no EXIF segment.
    expect(readImageExif(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toEqual(nothing);
  });

  it("does not run off the end of a truncated header", () => {
    const whole = jpegWithExif({ dateTimeOriginal: "2026:07:06 14:53:56", orientation: 6 });
    // Every prefix, because a file cut short is the shape a half-written asset
    // takes and none of them may throw.
    for (let cut = 0; cut < whole.length; cut += 1) {
      expect(() => readImageExif(whole.subarray(0, cut))).not.toThrow();
    }
  });

  it("stops at the start of image data", () => {
    // Past SOS there is no segment structure, only entropy-coded bytes — which
    // contain `0xFFE1` often enough that a walker running past it will find a
    // segment that is not one.
    const bytes = jpegWithExif({ orientation: 3 });
    expect(readImageExif(bytes).orientation).toBe(3);
  });
});

describe("parseExifDate", () => {
  it("rewrites EXIF's own spelling as ISO 8601", () => {
    // The same output shape the cloud importer's `parseExifDate` produces.
    // `captured_at` is one column that both writers fill, and two spellings of a
    // timestamp in it cannot be ordered against each other.
    expect(parseExifDate("2026:07:06 14:53:56")).toBe("2026-07-06T14:53:56");
  });

  it("carries no timezone, because the file states none", () => {
    // EXIF records local time with no offset. A `Z` would assert something the
    // photograph does not say.
    expect(parseExifDate("2026:07:06 14:53:56")).not.toMatch(/Z$/);
  });

  it("rejects a clock that was never set", () => {
    // All zeroes parses structurally and describes no moment. Sorted into a
    // library it would claim to be the oldest photograph ever taken.
    expect(parseExifDate("0000:00:00 00:00:00")).toBeNull();
    expect(parseExifDate("2026:00:00 00:00:00")).toBeNull();
  });

  it("rejects anything that is not the EXIF shape", () => {
    expect(parseExifDate("2026-07-06T14:53:56")).toBeNull();
    expect(parseExifDate("")).toBeNull();
    expect(parseExifDate("not a date")).toBeNull();
  });
});
