/**
 * Minimal uncompressed RGB TIFF generated in-process — no binary files in the
 * repo. TIFF's IFD0 carries Make/Model/Orientation directly, so this is the
 * cheapest deterministic way to get a real image with EXIF-visible camera
 * fields that both exifr (metadata) and sharp (decode) understand.
 */

const SHORT = 3;
const LONG = 4;
const ASCII = 2;

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Inline value, or offset into the external area (caller decides). */
  value: number;
}

export interface TiffOptions {
  make?: string;
  model?: string;
  /** Square edge length in pixels. */
  size?: number;
  /** Solid fill color. */
  rgb?: [number, number, number];
}

export function tiffWithExif(options: TiffOptions = {}): Buffer {
  const make = (options.make ?? "TestMake") + "\0";
  const model = (options.model ?? "TestModel 3000") + "\0";
  const size = options.size ?? 8;
  const [r, g, b] = options.rgb ?? [10, 120, 200];

  const entryCount = 12;
  const ifdStart = 8;
  const ifdEnd = ifdStart + 2 + entryCount * 12 + 4;

  // External value area: BitsPerSample triple, then the two strings.
  const bpsOffset = ifdEnd;
  const makeOffset = bpsOffset + 6;
  const modelOffset = makeOffset + make.length;
  let stripOffset = modelOffset + model.length;
  if (stripOffset % 2 === 1) stripOffset += 1; // word-align the strip
  const stripBytes = size * size * 3;

  const entries: Entry[] = [
    { tag: 256, type: SHORT, count: 1, value: size }, // ImageWidth
    { tag: 257, type: SHORT, count: 1, value: size }, // ImageLength
    { tag: 258, type: SHORT, count: 3, value: bpsOffset }, // BitsPerSample
    { tag: 259, type: SHORT, count: 1, value: 1 }, // Compression: none
    { tag: 262, type: SHORT, count: 1, value: 2 }, // Photometric: RGB
    { tag: 271, type: ASCII, count: make.length, value: makeOffset }, // Make
    { tag: 272, type: ASCII, count: model.length, value: modelOffset }, // Model
    { tag: 273, type: LONG, count: 1, value: stripOffset }, // StripOffsets
    { tag: 274, type: SHORT, count: 1, value: 1 }, // Orientation
    { tag: 277, type: SHORT, count: 1, value: 3 }, // SamplesPerPixel
    { tag: 278, type: SHORT, count: 1, value: size }, // RowsPerStrip
    { tag: 279, type: LONG, count: 1, value: stripBytes }, // StripByteCounts
  ];

  const buf = Buffer.alloc(stripOffset + stripBytes);
  buf.write("II", 0, "ascii"); // little-endian
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifdStart, 4);

  buf.writeUInt16LE(entryCount, ifdStart);
  entries.forEach((entry, i) => {
    const at = ifdStart + 2 + i * 12;
    buf.writeUInt16LE(entry.tag, at);
    buf.writeUInt16LE(entry.type, at + 2);
    buf.writeUInt32LE(entry.count, at + 4);
    // Values ≤4 bytes are stored inline (left-justified); larger ones are
    // offsets — both cases reduce to one write since SHORT counts of 1 fit.
    if (entry.type === SHORT && entry.count === 1) {
      buf.writeUInt16LE(entry.value, at + 8);
    } else {
      buf.writeUInt32LE(entry.value, at + 8);
    }
  });
  // next-IFD pointer (0 = none) is already zeroed by Buffer.alloc.

  for (const [i, v] of [8, 8, 8].entries()) buf.writeUInt16LE(v, bpsOffset + i * 2);
  buf.write(make, makeOffset, "ascii");
  buf.write(model, modelOffset, "ascii");

  for (let px = 0; px < size * size; px++) {
    const at = stripOffset + px * 3;
    buf[at] = r;
    buf[at + 1] = g;
    buf[at + 2] = b;
  }

  return buf;
}
