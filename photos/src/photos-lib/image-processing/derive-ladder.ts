/**
 * Deriving the still ladder from one decoded source.
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
 * ## One decode, every rung — enforced, not merely intended
 *
 * This file has always claimed "one decode, every rung", and until
 * {@link decodeForDerivation} existed it was not true. Every `sharp(source)`
 * call decodes the source again, and there was one per rung, one for the
 * ThumbHash, one for the perceptual hash and two more for dimensions: nine full
 * decodes of the same 48 MP buffer, to produce output collectively smaller than
 * the input.
 *
 * The fix is to decode to raw pixels once and hand *those* to everything else.
 * A raw buffer fed back to sharp costs a memcpy rather than a decode, so the
 * count is now genuinely one however many rungs are asked for.
 *
 * ### The working image is capped at the top of the ladder
 *
 * Nothing derived here is ever larger than the ladder's top rung, so the decode
 * shrinks to `min(source long edge, top rung maximum)` and every rung comes off
 * that. The top rung emits exactly that size, so it is unaffected; the smaller
 * ones resize from an already-downscaled intermediate, which is what mipmapping
 * does and is visually equivalent.
 *
 * The cap is deliberately a property of the *ladder*, not of what the caller
 * asked for. A node deriving only the cheap rungs and a node deriving all of
 * them decode to the same working image, so the ThumbHash and the perceptual
 * hash they compute agree — and a perceptual hash that varied with which rungs
 * a node happened to want would make cross-node duplicate detection quietly
 * unreliable.
 *
 * ## Ordering is ascending, and rungs are yielded as they finish
 *
 * {@link deriveStillLadderStream} yields smallest first, so a caller can
 * publish each rung the moment it exists. That matters more than it sounds: the
 * bottom two rungs for an entire library cost about half a second against
 * nearly thirty for the full ladder, so a grid waiting on `image-large` waits
 * sixty times longer than the tile it is painting requires.
 *
 * This reverses an earlier `image-medium`-first order, whose reason was that
 * on-device AI reads that rung and ingest wanted to hand a model something
 * early. Ascending keeps that: `image-xsmall` and `image-thumb` together are a
 * few tens of milliseconds, so `image-medium` still arrives almost at once, and
 * now the tile does too.
 */

import {
  STILL_LADDER,
  applicableStillClasses,
  renditionLongEdge,
  type SizeClass,
  type StillClassSpec,
} from "../ladder";
import { decodeSource } from "./decode-source";
import type { PlatformDecoder } from "./platform-decoder";

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
  /**
   * The source's Starkeep type, so raw and HEIC can be routed to a decoder that
   * can actually read them.
   *
   * Optional, and omitting it means "these bytes are already something sharp
   * reads". That keeps every existing caller correct: JPEG and PNG need no
   * normalisation, and a caller that does not know the type is better off
   * trying than guessing wrong.
   */
  readonly sourceType?: string;
  /** Used only for HEIC/HEIF; ignored for everything else. */
  readonly platformDecoder?: PlatformDecoder;
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
 * What a rung is encoded as when the caller expresses no preference, which is
 * every shipping caller: the resize route, the cloud Lambda and the derivation
 * worker all omit `codec`.
 */
export const DEFAULT_RENDITION_CODEC: NonNullable<DeriveLadderOptions["codec"]> = "avif";

/**
 * The canonical Starkeep type a published rung carries. Named rather than
 * spelled at each assertion site, so changing the default encoder changes one
 * line instead of leaving a test pinned to the old format.
 */
export const DEFAULT_RENDITION_TYPE: string = CODEC_TYPES[DEFAULT_RENDITION_CODEC].type;

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
 * The decoded working image every derivation step reads.
 *
 * Raw pixels rather than an encoded buffer, because that is the only shape
 * sharp will accept without decoding again. `source` carries the *original's*
 * dimensions, which is what the ladder is computed against — the working image
 * may be smaller, and resolving rungs against its size instead would quietly
 * drop the top rung for every photo above the cap.
 */
export interface DecodedImage {
  readonly pixels: Buffer;
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly source: SourceDimensions;
}

/**
 * The long edge the working image is decoded to.
 *
 * The ladder's top rung: no output is ever larger, so decoding above it would
 * be pixels nothing reads. Read off {@link STILL_LADDER} rather than written
 * down, so respecifying the ladder cannot leave this behind.
 */
const WORKING_LONG_EDGE = STILL_LADDER[STILL_LADDER.length - 1]!.maxLongEdge;

function isDecoded(input: Uint8Array | DecodedImage): input is DecodedImage {
  return typeof (input as DecodedImage).channels === "number";
}

/**
 * Decode a source once, into the buffer every rung and every hash reads.
 *
 * Raw and HEIC are normalised first — raw to its embedded preview, HEIC via the
 * platform decoder. Both throw UndecodableError when this node cannot read the
 * format, which is what makes the outcome terminal rather than something a
 * sweeper retries daily forever.
 */
export async function decodeForDerivation(
  imageBytes: Uint8Array,
  options: DeriveLadderOptions = {},
): Promise<DecodedImage> {
  const { default: sharp } = (await import("sharp")) as {
    default: typeof import("sharp").default;
  };

  const normalised = options.sourceType
    ? await decodeSource(imageBytes, options.sourceType, {
        ...(options.platformDecoder ? { platformDecoder: options.platformDecoder } : {}),
      })
    : { bytes: imageBytes, via: "direct" as const };

  const source = await readSourceDimensions(normalised.bytes);
  if (source.longEdge === 0) {
    throw new Error("Cannot derive a ladder from an image with no readable dimensions");
  }

  // `.rotate()` applies the EXIF orientation, so everything downstream works in
  // display orientation and no later step has to think about it again. The raw
  // buffer carries no EXIF, which is the point: orientation is resolved once,
  // here, and cannot be applied twice by accident.
  const working = Math.min(source.longEdge, WORKING_LONG_EDGE);
  const { data, info } = await sharp(Buffer.from(normalised.bytes))
    .rotate()
    .resize(working, working, {
      fit: "inside",
      kernel: "lanczos3",
      withoutEnlargement: true,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    pixels: data,
    width: info.width,
    height: info.height,
    channels: info.channels,
    source,
  };
}

/** Feed the working image back to sharp. Costs a copy, not a decode. */
function fromDecoded(
  sharp: typeof import("sharp").default,
  decoded: DecodedImage,
): import("sharp").Sharp {
  return sharp(decoded.pixels, {
    raw: { width: decoded.width, height: decoded.height, channels: decoded.channels as 1 | 2 | 3 | 4 },
  });
}

async function asDecoded(
  input: Uint8Array | DecodedImage,
  options: DeriveLadderOptions,
): Promise<DecodedImage> {
  return isDecoded(input) ? input : decodeForDerivation(input, options);
}

/** Which rungs this source produces, ascending, after any `only` filter. */
function rungsFor(
  decoded: DecodedImage,
  options: DeriveLadderOptions,
): StillClassSpec[] {
  const classes = applicableStillClasses(decoded.source.longEdge);
  if (!options.only) return classes;
  const wanted = new Set(options.only);
  return classes.filter((c) => wanted.has(c.sizeClass));
}

/**
 * Produce every applicable rung, yielding each as it finishes.
 *
 * Ascending, so the caller can publish the tile-sized rungs while the expensive
 * ones are still encoding. A caller that publishes inside the loop turns a
 * thirty-second wait for a visible grid into a sub-second one.
 *
 * Accepts either bytes or an already-{@link decodeForDerivation}d source, so a
 * caller that also wants the ThumbHash and the perceptual hash can decode once
 * and pass the result to all three.
 */
export async function* deriveStillLadderStream(
  input: Uint8Array | DecodedImage,
  options: DeriveLadderOptions = {},
): AsyncGenerator<DerivedRendition> {
  const { default: sharp } = (await import("sharp")) as {
    default: typeof import("sharp").default;
  };
  const codec = options.codec ?? DEFAULT_RENDITION_CODEC;
  const { type, contentType } = CODEC_TYPES[codec];
  const decoded = await asDecoded(input, options);

  for (const spec of rungsFor(decoded, options)) {
    yield await encodeOne(sharp, decoded, spec, codec, type, contentType);
  }
}

/**
 * Every applicable rung, collected.
 *
 * The convenience form of {@link deriveStillLadderStream} for callers that have
 * nothing useful to do with a rung before the rest arrive — tests, mostly.
 * Anything publishing renditions should stream instead, or it reintroduces the
 * wait the streaming form exists to remove.
 */
export async function deriveStillLadder(
  input: Uint8Array | DecodedImage,
  options: DeriveLadderOptions = {},
): Promise<DerivedRendition[]> {
  const out: DerivedRendition[] = [];
  for await (const rendition of deriveStillLadderStream(input, options)) out.push(rendition);
  return out;
}

async function encodeOne(
  sharp: typeof import("sharp").default,
  decoded: DecodedImage,
  spec: StillClassSpec,
  codec: NonNullable<DeriveLadderOptions["codec"]>,
  type: string,
  contentType: string,
): Promise<DerivedRendition> {
  // Against the *original's* long edge, not the working image's: Rule 1 is
  // about what the source could support, and a working image already clamped to
  // the top rung would make every rung above the clamp resolve to the clamp.
  const target = renditionLongEdge(spec, decoded.source.longEdge);
  const pipeline = fromDecoded(sharp, decoded).resize(target, target, {
    fit: "inside",
    kernel: "lanczos3",
    // Rule 1, enforced by the encoder as well as by the arithmetic above. A
    // class must never emit a file larger than its source, and belt-and-braces
    // here costs nothing.
    withoutEnlargement: true,
  });

  const { data, info } =
    codec === "avif"
      ? // **`chromaSubsampling` is set rather than left to sharp**, whose AVIF
        // default is `4:4:4` — unlike its JPEG default, and unlike what anyone
        // reading `avif({ quality })` would assume. Full-resolution chroma
        // emits AV1 *profile 1* instead of Main, which is the narrower of the
        // two profiles decoders actually implement, and it costs real bytes for
        // a difference nobody can see in a photograph: measured on a 3024×4032
        // still off the phone, the same picture is 1.20 MB at 4:4:4 and 748 KB
        // at 4:2:0, a 38% saving at identical quality.
        //
        // This is not what makes AVIF renditions unpaintable on Android — a
        // Pixel 5 on API 34 fails the same picture at both profiles — so it is
        // a size and compatibility fix, not the fix for that. See
        // `photos-mobile-status-2026-08-31.md`.
        await pipeline
          .avif({ quality: spec.quality, chromaSubsampling: "4:2:0" })
          .toBuffer({ resolveWithObject: true })
      : codec === "webp"
        ? await pipeline.webp({ quality: spec.quality }).toBuffer({ resolveWithObject: true })
        : await pipeline.jpeg({ quality: spec.quality }).toBuffer({ resolveWithObject: true });

  // Taken from the encode's own output info rather than by re-reading the
  // encoded buffer, which was a tenth decode hiding behind a metadata() call.
  return {
    sizeClass: spec.sizeClass,
    data: new Uint8Array(data),
    width: info.width,
    height: info.height,
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
export async function computeThumbHash(
  input: Uint8Array | DecodedImage,
  options: DeriveLadderOptions = {},
): Promise<string> {
  const { default: sharp } = (await import("sharp")) as {
    default: typeof import("sharp").default;
  };
  const { rgbaToThumbHash } = await import("thumbhash");
  const decoded = await asDecoded(input, options);

  // ThumbHash requires a source of at most 100×100. `fit: "inside"` preserves
  // aspect ratio, which the format encodes and the decoder reproduces.
  const { data, info } = await fromDecoded(sharp, decoded)
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
export async function computePerceptualHash(
  input: Uint8Array | DecodedImage,
  options: DeriveLadderOptions = {},
): Promise<string> {
  const { default: sharp } = (await import("sharp")) as {
    default: typeof import("sharp").default;
  };
  const decoded = await asDecoded(input, options);

  // 9×8 greyscale: each row yields 8 comparisons between horizontally adjacent
  // pixels, for 64 bits total.
  const { data } = await fromDecoded(sharp, decoded)
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
