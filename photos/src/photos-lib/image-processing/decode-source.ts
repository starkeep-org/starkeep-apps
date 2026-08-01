/**
 * Getting source bytes into a form the ladder pipeline can read.
 *
 * Three inputs need help before sharp sees them, and each is handled by the
 * cheapest thing that works:
 *
 * - **Raw (DNG, CR3, NEF, …)** — take the camera's own embedded full-size JPEG
 *   preview. No demosaicing, no colour science, and the result looks like the
 *   photo the photographer saw.
 * - **HEIC/HEIF** — hand to the platform decoder, because sharp's bundled
 *   libheif has no HEVC decoder however loudly it claims otherwise.
 * - **Everything else** — pass straight through.
 *
 * Everything downstream stays exactly as it was. That is the point: resizing,
 * AVIF encoding, ThumbHash and the perceptual hash are already correct and well
 * tested against ordinary bitmaps, and a second pipeline per input format would
 * be several code paths that drift apart.
 */

import { UndecodableError, classifyDecodeError } from "./decode-errors";
import { extractLargestPreview, isRawType } from "./dng-preview";
import {
  NO_PLATFORM_DECODER,
  needsPlatformDecoder,
  type PlatformDecoder,
} from "./platform-decoder";

export interface DecodeSourceOptions {
  /** Defaults to a decoder that is never available, so callers opt in. */
  readonly platformDecoder?: PlatformDecoder;
}

export interface DecodedSource {
  readonly bytes: Uint8Array;
  /** How the bytes were obtained — for reporting, and for tests to assert on. */
  readonly via: "direct" | "embedded-preview" | "platform-decoder";
}

/**
 * Normalise source bytes for the ladder pipeline.
 *
 * Throws {@link UndecodableError} when this node cannot read the format at all.
 * That is terminal *here* and not everywhere: the same HEIC a Linux container
 * refuses decodes fine on a laptop, which is why the ledger recording it is
 * node-local.
 */
export async function decodeSource(
  bytes: Uint8Array,
  type: string,
  options: DecodeSourceOptions = {},
): Promise<DecodedSource> {
  if (isRawType(type)) {
    const preview = extractLargestPreview(bytes);
    if (preview) return { bytes: preview, via: "embedded-preview" };
    // No preview and no raw decoder. Terminal rather than retryable: the file
    // does not contain what is needed, and it will not start containing it.
    throw new UndecodableError(
      `${type} has no embedded JPEG preview and this build cannot decode raw sensor data`,
      type,
    );
  }

  if (needsPlatformDecoder(type)) {
    const decoder = options.platformDecoder ?? NO_PLATFORM_DECODER;
    if (!(await decoder.available())) {
      // The honest answer on a Linux container. Recorded as terminal so the
      // sweeper does not re-fail on every HEIC daily — and the consequence,
      // that such records stay ladder-incomplete and therefore never archived,
      // is the accepted trade rather than an oversight.
      throw new UndecodableError(
        `no decoder for ${type} on this node (sharp's libheif has no HEVC support)`,
        type,
      );
    }
    try {
      return { bytes: await decoder.toJpeg(bytes, type), via: "platform-decoder" };
    } catch (err) {
      classifyDecodeError(err, type);
    }
  }

  return { bytes, via: "direct" };
}

/**
 * Whether a node can derive from this type at all, given what it has.
 *
 * Answered without touching bytes so a sweeper can skip work it cannot do,
 * rather than reading a 40 MB original to discover the same thing. Raw is
 * reported decodable because *most* raw carries a preview — whether a specific
 * file does cannot be known without opening it, and assuming the pessimistic
 * answer would skip every raw file in the library.
 */
export async function canDecodeHere(
  type: string,
  options: DecodeSourceOptions = {},
): Promise<boolean> {
  if (isRawType(type)) return true;
  if (needsPlatformDecoder(type)) {
    return (options.platformDecoder ?? NO_PLATFORM_DECODER).available();
  }
  return true;
}
