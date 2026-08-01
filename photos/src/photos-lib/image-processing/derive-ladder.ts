/**
 * Deriving the whole still ladder from one decoded source.
 *
 * ## The rule this exists to obey
 *
 * Derive at the first point where the bytes are already resident, and **never
 * transfer an original in order to derive from it**. For capture that is the
 * phone; for bulk import it is wherever the import landed. Zero egress, zero
 * thaw, and no node ever pulls a 40 MB ProRAW down just to make a 20 KB tile.
 *
 * That rule is why this function takes bytes rather than a record id: it can
 * only be called by something that already holds them, and there is no code
 * path here that could fetch anything.
 *
 * ## One decode, every rung
 *
 * The classes are generated from a single decode of the source. Decoding a
 * 48 MP ProRAW is the expensive part — several hundred milliseconds and tens of
 * megabytes — and doing it once per rung would multiply that by four for output
 * that is, in total, smaller than the source.
 *
 * ## Ordering is not incidental
 *
 * `image-medium` is emitted first, because on-device AI reads it and ingest
 * wants to hand the model something as early as possible. Every routine model
 * input is ≤640 px, so `image-medium` at 1280 has 2× headroom, and using the
 * original instead would decode 48 MP to produce a 640 px letterbox — the same
 * argument that rules out the larger rungs, only more so.
 */

import {
  STILL_LADDER,
  applicableStillClasses,
  renditionLongEdge,
  type SizeClass,
  type StillClassSpec,
} from "../ladder";

export interface DerivedRendition {
  readonly sizeClass: SizeClass;
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Canonical Starkeep type of the output, e.g. `image/avif`. */
  readonly type: string;
  readonly contentType: string;
}

export interface DeriveLadderOptions {
  /**
   * Output codec.
   *
   * AVIF is the default because it is the reason the byte budgets in the plan
   * work at all. It is also 3–10× JPEG's CPU to encode, which is a real cost on
   * a phone and the reason this is a setting rather than a constant — a device
   * that cannot afford it should produce a bigger, cheaper file rather than
   * produce nothing.
   */
  readonly codec?: "avif" | "webp" | "jpeg";
  /** Restrict output to these classes. Defaults to every applicable class. */
  readonly only?: readonly SizeClass[];
}

const CODEC_TYPES: Record<NonNullable<DeriveLadderOptions["codec"]>, {
  type: string;
  contentType: string;
}> = {
  avif: { type: "image/avif", contentType: "image/avif" },
  webp: { type: "image/webp", contentType: "image/webp" },
  jpeg: { type: "image/jpeg", contentType: "image/jpeg" },
};

/**
 * The source dimensions a ladder is computed against.
 *
 * Read after `rotate()` has been applied, so a portrait photo stored with an
 * EXIF orientation flag is measured as portrait. Measuring the stored buffer
 * instead would put a 4000×3000 landscape original into the wrong rung set
 * whenever the camera wrote it rotated.
 */
export interface SourceDimensions {
  readonly width: number;
  readonly height: number;
  readonly longEdge: number;
}

export async function readSourceDimensions(
  imageBytes: Uint8Array,
): Promise<SourceDimensions> {
  const { default: sharp } = (await import("sharp")) as {
    default: typeof import("sharp").default;
  };
  // `.rotate()` with no argument applies the EXIF orientation; taking metadata
  // from the rotated pipeline is what makes a rotated portrait measure as one.
  const meta = await sharp(Buffer.from(imageBytes)).rotate().metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  return { width, height, longEdge: Math.max(width, height) };
}

/**
 * Produce every applicable rung for this source.
 *
 * Returns them in the order they should be *used*, not in ladder order — see
 * the note above about `image-medium`. Callers that want ladder order should
 * sort by the class's position in {@link STILL_LADDER}.
 */
export async function deriveStillLadder(
  imageBytes: Uint8Array,
  options: DeriveLadderOptions = {},
): Promise<DerivedRendition[]> {
  const { default: sharp } = (await import("sharp")) as {
    default: typeof import("sharp").default;
  };
  const codec = options.codec ?? "avif";
  const { type, contentType } = CODEC_TYPES[codec];

  const source = Buffer.from(imageBytes);
  const dims = await readSourceDimensions(imageBytes);
  if (dims.longEdge === 0) {
    throw new Error("Cannot derive a ladder from an image with no readable dimensions");
  }

  let classes = applicableStillClasses(dims.longEdge);
  if (options.only) {
    const wanted = new Set(options.only);
    classes = classes.filter((c) => wanted.has(c.sizeClass));
  }

  const out: DerivedRendition[] = [];
  for (const spec of orderForUse(classes)) {
    out.push(await encodeOne(sharp, source, spec, dims, codec, type, contentType));
  }
  return out;
}

/**
 * `image-medium` first, then ascending.
 *
 * Ingest runs AI off `image-medium`, so emitting it first lets the model start
 * while the larger rungs are still encoding. The rest ascend because a caller
 * streaming results upward wants the cheap ones available soonest.
 */
function orderForUse(classes: readonly StillClassSpec[]): StillClassSpec[] {
  const medium = classes.find((c) => c.sizeClass === "image-medium");
  if (!medium) return [...classes];
  return [medium, ...classes.filter((c) => c !== medium)];
}

async function encodeOne(
  sharp: typeof import("sharp").default,
  source: Buffer,
  spec: StillClassSpec,
  dims: SourceDimensions,
  codec: NonNullable<DeriveLadderOptions["codec"]>,
  type: string,
  contentType: string,
): Promise<DerivedRendition> {
  const target = renditionLongEdge(spec, dims.longEdge);
  const pipeline = sharp(source)
    .rotate()
    .resize(target, target, {
      fit: "inside",
      kernel: "lanczos3",
      // Rule 1, enforced by the encoder as well as by the arithmetic above. A
      // class must never emit a file larger than its source, and belt-and-braces
      // here costs nothing.
      withoutEnlargement: true,
    });

  const encoded =
    codec === "avif"
      ? await pipeline.avif({ quality: spec.quality }).toBuffer()
      : codec === "webp"
        ? await pipeline.webp({ quality: spec.quality }).toBuffer()
        : await pipeline.jpeg({ quality: spec.quality }).toBuffer();

  const meta = await sharp(encoded).metadata();
  return {
    sizeClass: spec.sizeClass,
    data: new Uint8Array(encoded),
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    type,
    contentType,
  };
}

// ---------------------------------------------------------------------------
// Derivation state
// ---------------------------------------------------------------------------

/**
 * Which rungs a record is still missing.
 *
 * **Derivation state is a query, not a field.** There is no `needs-derivation`
 * flag anywhere: a missing class is simply the absence of a child record
 * carrying `photos/rendition=<class>`, which the parentId filter makes cheap —
 * and it is the same query the ladder-complete gate needs, so the two cannot
 * disagree.
 *
 * A shared mutable "somebody should fix this" flag was considered and rejected:
 * it invites two nodes to derive the same record and produce two children,
 * which is worse than the problem it solves.
 */
export function missingRenditionClasses(
  originalLongEdge: number,
  existingClasses: readonly string[],
): SizeClass[] {
  const have = new Set(existingClasses);
  return applicableStillClasses(originalLongEdge)
    .map((s) => s.sizeClass)
    .filter((c) => !have.has(c));
}

/**
 * True when every applicable rung exists.
 *
 * This is the archive gate's predicate. An original may only be frozen once
 * something cheaper is readable in its place — which is also what makes the
 * cloud derivation fallback guaranteed thaw-free, since an incomplete original
 * is by construction still instantly readable.
 */
export function ladderIsComplete(
  originalLongEdge: number,
  existingClasses: readonly string[],
): boolean {
  return missingRenditionClasses(originalLongEdge, existingClasses).length === 0;
}

/**
 * Formats the cloud derivation fallback can actually decode.
 *
 * Deliberately narrow. The custom libvips build that would add HEIC and raw is
 * rejected for now, so the fallback simply cannot reach those records — and
 * saying so explicitly is what lets the sweeper record "undecodable here"
 * once instead of retrying the same file every day forever.
 */
export const CLOUD_DECODABLE_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
];

export function cloudCanDecode(type: string): boolean {
  return CLOUD_DECODABLE_TYPES.includes(type);
}

// ---------------------------------------------------------------------------
// ThumbHash
// ---------------------------------------------------------------------------

/**
 * A ~25-byte inline placeholder, base64-encoded for storage on the record.
 *
 * This is stage zero of progressive presentation, and the reason it lives on
 * the record rather than in object storage is the whole point: it costs **zero
 * requests**. A grid can paint every tile before a single byte of image data is
 * fetched. Putting it in object storage — or deriving it lazily — would make
 * the placeholder cost exactly what it exists to avoid.
 *
 * Computed here because derivation already holds a decoded bitmap. Doing it
 * separately would mean a second full decode for 25 bytes.
 *
 * ThumbHash rather than a tiny JPEG or a dominant colour: it encodes enough
 * structure to read as *this* photo (and carries alpha), while a dominant
 * colour reads as a loading state and a tiny JPEG is an order of magnitude
 * larger and still needs decoding.
 */
export async function computeThumbHash(imageBytes: Uint8Array): Promise<string> {
  const { default: sharp } = (await import("sharp")) as {
    default: typeof import("sharp").default;
  };
  const { rgbaToThumbHash } = await import("thumbhash");

  // ThumbHash requires a source of at most 100×100. `fit: "inside"` preserves
  // aspect ratio, which the format encodes and the decoder reproduces.
  const { data, info } = await sharp(Buffer.from(imageBytes))
    .rotate()
    .resize(100, 100, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const hash = rgbaToThumbHash(info.width, info.height, data);
  return Buffer.from(hash).toString("base64");
}

// ---------------------------------------------------------------------------
// Perceptual hash
// ---------------------------------------------------------------------------

/**
 * A 64-bit perceptual hash (difference hash), as 16 hex characters.
 *
 * Deliberately **not** an identity. It matches re-encodes, resizes and
 * recompressions — which is exactly what makes it useful for finding import
 * duplicates, and exactly what makes it unsafe as a key. Two genuinely
 * different photos can collide; a burst of near-identical frames will collide
 * on purpose. `contentHash` decides identity; this only proposes candidates for
 * a human or a stricter tier to confirm.
 *
 * dHash rather than aHash or pHash: it compares adjacent pixels, so it is
 * invariant to overall brightness and contrast changes (a Storage Saver
 * re-encode, an auto-levels pass) in a way an average hash is not, and it needs
 * no DCT.
 *
 * Computed during derivation because the decoded bitmap is already in hand.
 */
export async function computePerceptualHash(imageBytes: Uint8Array): Promise<string> {
  const { default: sharp } = (await import("sharp")) as {
    default: typeof import("sharp").default;
  };

  // 9×8 greyscale: each row yields 8 comparisons between horizontally adjacent
  // pixels, for 64 bits total.
  const { data } = await sharp(Buffer.from(imageBytes))
    .rotate()
    .greyscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Built a nibble at a time rather than as a 64-bit integer: this project
  // targets below ES2020, so BigInt literals are unavailable, and a pair of
  // 32-bit halves would be more moving parts than the hex string it produces.
  let hex = "";
  for (let row = 0; row < 8; row++) {
    for (let nibble = 0; nibble < 2; nibble++) {
      let value = 0;
      for (let bit = 0; bit < 4; bit++) {
        const col = nibble * 4 + bit;
        const left = data[row * 9 + col]!;
        const right = data[row * 9 + col + 1]!;
        value = (value << 1) | (left > right ? 1 : 0);
      }
      hex += value.toString(16);
    }
  }
  return hex;
}

/**
 * Hamming distance between two perceptual hashes, in bits.
 *
 * The comparison a threshold is applied to. Returns 64 (maximum distance) for
 * malformed input rather than throwing, so one bad stored hash cannot abort a
 * whole import scan — and 64 means "as different as possible", which is the
 * safe direction: it will never cause a false duplicate.
 */
export function perceptualDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return 64;
  // Nibble by nibble, for the same ES-target reason as the hash itself.
  let distance = 0;
  for (let i = 0; i < 16; i++) {
    let diff = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (diff > 0) {
      distance += diff & 1;
      diff >>= 1;
    }
  }
  return distance;
}
