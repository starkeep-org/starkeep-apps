/**
 * Getting raw and HEIC into a form the ladder pipeline can read.
 *
 * The HEIC half is tested against a **real HEVC-profile HEIC**, produced with
 * the macOS encoder, because the whole bug is that a synthetic or AVIF-shaped
 * fixture would decode fine and prove nothing.
 *
 * The DNG half is tested against a TIFF built here byte by byte. That is not a
 * shortcut: the thing under test is an IFD walker, and a hand-built file is the
 * only way to control exactly which previews exist and how they are reachable.
 * It is also not sufficient on its own — a real RICOH GR IV file found a bug
 * none of these fixtures could have (see "skips the raw mosaic" below), and
 * `dng-real-file.test.ts` is where that verification lives.
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findEmbeddedPreviews,
  extractLargestPreview,
  isRawType,
} from "../src/photos-lib/image-processing/dng-preview";
import { decodeSource, canDecodeHere } from "../src/photos-lib/image-processing/decode-source";
import {
  createSipsDecoder,
  NO_PLATFORM_DECODER,
  needsPlatformDecoder,
} from "../src/photos-lib/image-processing/platform-decoder";
import {
  UndecodableError,
  isNoDecoderError,
} from "../src/photos-lib/image-processing/decode-errors";

const run = promisify(execFile);

// ---------------------------------------------------------------------------
// Building a TIFF/DNG by hand, so the preview layout is exactly known.
// ---------------------------------------------------------------------------

/** Minimal JPEG: SOI + a filler byte + EOI. Enough to be recognised as one. */
const jpegOf = (marker: number) => new Uint8Array([0xff, 0xd8, marker, 0xff, 0xd9]);

interface FakeIfd {
  width: number;
  height: number;
  compression: number;
  jpeg: Uint8Array;
  /** Defaults to YCbCr — a viewable preview. 32803 is CFA sensor data. */
  photometric?: number;
}

/**
 * A little-endian TIFF whose IFD0 chains to one IFD per entry.
 *
 * Deliberately uses the IFD *chain* rather than SubIFDs for the simple cases,
 * and a dedicated test below covers SubIFDs — because following only one of the
 * two is precisely the bug that finds a thumbnail and misses the full-size
 * preview.
 */
function buildTiff(ifds: FakeIfd[]): Uint8Array {
  const ENTRY_COUNT = 8;
  const ifdSize = 2 + ENTRY_COUNT * 12 + 4;
  const headerSize = 8;
  let cursor = headerSize + ifds.length * ifdSize;
  const jpegOffsets = ifds.map((f) => {
    const at = cursor;
    cursor += f.jpeg.byteLength;
    return at;
  });

  const out = new Uint8Array(cursor);
  const view = new DataView(out.buffer);
  out[0] = 0x49;
  out[1] = 0x49; // "II"
  view.setUint16(2, 42, true);
  view.setUint32(4, headerSize, true);

  ifds.forEach((f, i) => {
    const base = headerSize + i * ifdSize;
    view.setUint16(base, ENTRY_COUNT, true);
    const entry = (n: number, tag: number, type: number, count: number, value: number) => {
      const at = base + 2 + n * 12;
      view.setUint16(at, tag, true);
      view.setUint16(at + 2, type, true);
      view.setUint32(at + 4, count, true);
      view.setUint32(at + 8, value, true);
    };
    entry(0, 0x00fe, 4, 1, i === 0 ? 0 : 1);
    entry(1, 0x0100, 4, 1, f.width);
    entry(2, 0x0101, 4, 1, f.height);
    entry(3, 0x0103, 3, 1, f.compression);
    entry(4, 0x0111, 4, 1, jpegOffsets[i]!);
    entry(5, 0x0117, 4, 1, f.jpeg.byteLength);
    entry(6, 0x0106, 3, 1, f.photometric ?? 6);
    entry(7, 0x0131, 2, 1, 0);
    // Chain to the next IFD, or 0 to end.
    view.setUint32(base + 2 + ENTRY_COUNT * 12, i + 1 < ifds.length ? base + ifdSize : 0, true);
    out.set(f.jpeg, jpegOffsets[i]!);
  });

  return out;
}

describe("finding a DNG's embedded previews", () => {
  it("finds a JPEG preview described by the IFD", () => {
    const dng = buildTiff([{ width: 4032, height: 3024, compression: 7, jpeg: jpegOf(0x01) }]);
    const previews = findEmbeddedPreviews(dng);
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({ width: 4032, height: 3024 });
  });

  // The failure that looks like success. A camera writes a 160x120 thumbnail
  // beside the full-resolution render; taking the first builds an entire ladder
  // from the thumbnail — every rung produced, every one useless, nothing in the
  // output resembling an error.
  it("prefers the largest preview, not the first one found", () => {
    const dng = buildTiff([
      { width: 160, height: 120, compression: 7, jpeg: jpegOf(0x01) },
      { width: 4032, height: 3024, compression: 7, jpeg: jpegOf(0x02) },
    ]);
    const previews = findEmbeddedPreviews(dng);
    expect(previews[0]!.width).toBe(4032);
    // And the extracted bytes are the big one's, not merely its dimensions.
    expect(extractLargestPreview(dng)![2]).toBe(0x02);
  });

  // The bug a real camera file found, kept reproducible without a 30 MB
  // fixture. A DNG stores its raw sensor mosaic with Compression 7 — lossless
  // JPEG — exactly like it stores a preview, and the raw is always the larger
  // of the two. Filtering on compression alone therefore selects 14-bit
  // lossless JPEG that no ordinary decoder opens, and it is most of the file,
  // so the point of reading a preview instead of the raw is lost as well.
  // PhotometricInterpretation is what actually says "a human can look at this".
  it("skips the raw mosaic and takes the smaller real preview", () => {
    const dng = buildTiff([
      // Bigger, JPEG-compressed, and CFA — the sensor data.
      { width: 6304, height: 4224, compression: 7, photometric: 32803, jpeg: jpegOf(0xaa) },
      // Smaller, JPEG-compressed, YCbCr — the actual preview.
      { width: 6192, height: 4128, compression: 7, photometric: 6, jpeg: jpegOf(0xbb) },
    ]);
    const previews = findEmbeddedPreviews(dng);
    expect(previews).toHaveLength(1);
    expect(previews[0]!.width).toBe(6192);
    expect(extractLargestPreview(dng)![2]).toBe(0xbb);
  });

  it("also skips LinearRaw, the other non-viewable photometric", () => {
    const dng = buildTiff([
      { width: 6000, height: 4000, compression: 7, photometric: 34892, jpeg: jpegOf(0x01) },
    ]);
    expect(findEmbeddedPreviews(dng)).toEqual([]);
  });

  it("ignores IFDs that are not JPEG-compressed", () => {
    // Compression 1 is uncompressed sensor data — the thing this exists to
    // avoid touching.
    const dng = buildTiff([{ width: 6000, height: 4000, compression: 1, jpeg: jpegOf(0x01) }]);
    expect(findEmbeddedPreviews(dng)).toHaveLength(0);
  });

  it("returns nothing for a file that is not a TIFF at all", () => {
    expect(findEmbeddedPreviews(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual([]);
    expect(findEmbeddedPreviews(new Uint8Array([]))).toEqual([]);
    expect(findEmbeddedPreviews(new Uint8Array([0x49, 0x49]))).toEqual([]);
  });

  // BigTIFF lays its IFDs out differently. Parsed as TIFF it would read garbage
  // offsets that could point anywhere in the file.
  it("refuses BigTIFF rather than misparsing it", () => {
    const big = new Uint8Array(16);
    big[0] = 0x49; big[1] = 0x49;
    new DataView(big.buffer).setUint16(2, 43, true);
    expect(findEmbeddedPreviews(big)).toEqual([]);
  });

  // A malformed or hostile file can point IFDs at each other; without a guard
  // the walk never terminates.
  it("terminates on a self-referential IFD chain", () => {
    const dng = buildTiff([{ width: 100, height: 100, compression: 7, jpeg: jpegOf(0x01) }]);
    // Point IFD0's "next" pointer back at itself.
    new DataView(dng.buffer).setUint32(8 + 2 + 7 * 12, 8, true);
    expect(() => findEmbeddedPreviews(dng)).not.toThrow();
  });

  // Offsets that point somewhere plausible but wrong would otherwise hand back
  // arbitrary bytes that fail much later, in a decoder, about the wrong thing.
  it("rejects a preview whose bytes are not actually a JPEG", () => {
    const dng = buildTiff([
      { width: 4032, height: 3024, compression: 7, jpeg: new Uint8Array([0x00, 0x11, 0x22]) },
    ]);
    expect(extractLargestPreview(dng)).toBeNull();
  });

  it("rejects a preview whose length runs past the end of the file", () => {
    const dng = buildTiff([{ width: 4032, height: 3024, compression: 7, jpeg: jpegOf(0x01) }]);
    // Overstate the byte count.
    new DataView(dng.buffer).setUint32(8 + 2 + 5 * 12 + 8, 999_999, true);
    expect(findEmbeddedPreviews(dng)).toEqual([]);
  });
});

describe("classifying decode failures", () => {
  // The live bug. libvips' actual message for an iPhone photo contains neither
  // "unsupported" nor "undecodable", so the old regex classified the most
  // common capture format in the world as transient and retried it forever.
  it("recognises libvips' real no-decoder message", () => {
    expect(
      isNoDecoderError(
        new Error(
          "heif: Error while loading plugin: Support for this compression format has not been built in (11.6003)",
        ),
      ),
    ).toBe(true);
  });

  it("recognises a typed UndecodableError regardless of wording", () => {
    expect(isNoDecoderError(new UndecodableError("anything at all"))).toBe(true);
  });

  // The safe direction. Guessing "terminal" for an unfamiliar message abandons
  // files a retry would have imported, silently and permanently.
  it("leaves an unrecognised failure retryable", () => {
    expect(isNoDecoderError(new Error("connection reset by peer"))).toBe(false);
    expect(isNoDecoderError(new Error("ENOSPC: no space left on device"))).toBe(false);
  });
});

describe("routing a source to the right decoder", () => {
  it("passes ordinary formats straight through", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await decodeSource(bytes, "image/jpeg")).toEqual({ bytes, via: "direct" });
  });

  it("takes the embedded preview for raw", async () => {
    const dng = buildTiff([{ width: 4032, height: 3024, compression: 7, jpeg: jpegOf(0x07) }]);
    const decoded = await decodeSource(dng, "image/dng");
    expect(decoded.via).toBe("embedded-preview");
    expect(decoded.bytes[2]).toBe(0x07);
  });

  it("fails terminally for raw with no preview, since it will never grow one", async () => {
    const dng = buildTiff([{ width: 6000, height: 4000, compression: 1, jpeg: jpegOf(0x01) }]);
    await expect(decodeSource(dng, "image/dng")).rejects.toBeInstanceOf(UndecodableError);
  });

  it("knows which types sharp genuinely cannot read", () => {
    expect(needsPlatformDecoder("image/heic")).toBe(true);
    expect(needsPlatformDecoder("image/heif")).toBe(true);
    // AVIF is HEIF-shaped but uses AV1, which the bundled libheif does have —
    // routing it to a subprocess would be slower for no reason.
    expect(needsPlatformDecoder("image/avif")).toBe(false);
    expect(needsPlatformDecoder("image/jpeg")).toBe(false);
  });

  // The honest answer on a Linux container. Terminal so the sweeper does not
  // re-fail on every HEIC daily; the consequence — such records stay
  // ladder-incomplete and are therefore never archived — is the accepted trade.
  it("fails terminally for HEIC with no platform decoder", async () => {
    await expect(
      decodeSource(new Uint8Array([1]), "image/heic", { platformDecoder: NO_PLATFORM_DECODER }),
    ).rejects.toBeInstanceOf(UndecodableError);
  });

  it("reports up front what it can decode, without reading bytes", async () => {
    expect(await canDecodeHere("image/jpeg")).toBe(true);
    // Most raw carries a preview; whether a given file does cannot be known
    // without opening it, and assuming otherwise would skip every raw file.
    expect(await canDecodeHere("image/dng")).toBe(true);
    expect(await canDecodeHere("image/heic", { platformDecoder: NO_PLATFORM_DECODER })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Against a real HEVC-profile HEIC.
// ---------------------------------------------------------------------------

/**
 * Built at module load, deliberately.
 *
 * `it` versus `it.skip` is decided while the suite is *collected*, which
 * happens before any `beforeAll` runs — so a fixture built in a hook is still
 * null when the choice is made and the test silently skips. A suite that
 * reports green while testing nothing is worse than one that fails.
 */
const dir = await mkdtemp(join(tmpdir(), "photos-heic-"));

async function buildHeicFixture(): Promise<Uint8Array | null> {
  if (process.platform !== "darwin") return null;
  try {
    const png = join(dir, "src.png");
    const out = join(dir, "real.heic");
    // Encoded by macOS itself, so the result is genuinely HEVC-in-HEIF. A
    // synthetic fixture would not reproduce the bug at all: sharp's libheif
    // handles AVIF-in-HEIF perfectly well, and only HEVC is missing.
    const sharp = (await import("sharp")).default;
    await sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: 200, g: 80, b: 40 } },
    })
      .png()
      .toFile(png);
    await run("sips", ["-s", "format", "heic", png, "--out", out]);
    return new Uint8Array(await readFile(out));
  } catch {
    return null;
  }
}

const heic = await buildHeicFixture();

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the HEIC fixture", () => {
  // Without this, the suite below can skip silently on a Mac where fixture
  // generation broke — reporting green while testing nothing, which is the
  // failure mode that lets a decoder regression ship unnoticed.
  it("is available on macOS, where this decoder is the whole point", () => {
    if (process.platform !== "darwin") return;
    expect(heic, "could not build a real HEIC fixture on macOS").not.toBeNull();
  });
});

const withHeic = () => (heic ? it : it.skip);

describe("HEIC through the platform decoder", () => {
  withHeic()("decodes what sharp cannot", async () => {
    const decoder = createSipsDecoder();
    expect(await decoder.available()).toBe(true);

    // sharp reads the metadata happily and then fails on the pixels — which is
    // the entire trap, and why "can I read metadata" is not a capability check.
    const sharp = (await import("sharp")).default;
    await expect(sharp(Buffer.from(heic!)).resize(64).jpeg().toBuffer()).rejects.toThrow();

    const decoded = await decodeSource(heic!, "image/heic", { platformDecoder: decoder });
    expect(decoded.via).toBe("platform-decoder");
    // And the result is something sharp reads normally.
    const meta = await sharp(Buffer.from(decoded.bytes)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBeGreaterThan(0);
  }, 120_000);
});

describe("raw type registry", () => {
  it("covers the types the manifest grants", () => {
    for (const t of ["image/dng", "image/cr3", "image/nef", "image/arw"]) {
      expect(isRawType(t), t).toBe(true);
    }
    expect(isRawType("image/jpeg")).toBe(false);
  });
});
