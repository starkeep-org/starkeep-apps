/**
 * The JavaScript face of {@link StarkeepMediaHashModule}.
 *
 * No state beyond the uploads in flight. `src/platform.ts` adapts the digests to
 * the import loop's `HashUri` and the sync engine's `HashFileParts`, and the
 * range upload to `UploadFileRange`, where the decisions that use them live and
 * are tested.
 */

import { requireOptionalNativeModule } from "expo";

export interface StarkeepMediaHash {
  /**
   * SHA-256 of whatever the content resolver opens at `uri`, as lowercase hex,
   * with the number of bytes the digest covered.
   *
   * Rejects when the resolver cannot open the URI, such as an asset deleted
   * since the media store listed it.
   */
  sha256OfUri(uri: string): Promise<{ hex: string; sizeBytes: number }>;

  /**
   * The same digest, plus the SHA-256 of each `partBytes` part, from one read.
   * A multipart upload pins each part to its digest; the whole-file digest is
   * what ties those parts to the object key.
   */
  sha256PartsOfUri(
    uri: string,
    partBytes: number,
  ): Promise<{ hex: string; sizeBytes: number; partHexes: string[] }>;

  /**
   * PUT `length` bytes of `uri`, starting at `offset`, to `url`. Resolves for
   * any completed response, with S3's `ETag` when it sent one.
   */
  uploadRangeOfUri(
    requestId: string,
    uri: string,
    offset: number,
    length: number,
    url: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string; etag: string | null }>;

  /** Abort the {@link uploadRangeOfUri} named `requestId`, if it is still running. */
  cancelUpload(requestId: string): void;

  /**
   * What a video's container says: its length, its display size, and its
   * recording date as ISO UTC (null when it holds none).
   */
  videoFactsOfUri(
    uri: string,
  ): Promise<{ durationMs: number; width: number; height: number; capturedAt: string | null }>;

  /**
   * Decode one frame of `uri` at `timeUs`, turn it upright, and write it as a
   * JPEG at each requested long edge, never upscaled.
   */
  extractPostersOfUri(
    uri: string,
    timeUs: number,
    outputs: Array<{ maxLongEdge: number; path: string }>,
    quality: number,
  ): Promise<Array<{ path: string; width: number; height: number; sizeBytes: number }>>;

  /** Whether reads may ask for an asset's unredacted bytes (`ACCESS_MEDIA_LOCATION`). */
  mediaLocationGranted(): boolean;
}

/**
 * Null when the native module is not in the binary.
 *
 * Optional rather than required for the reason `starkeep-timer` gives: a
 * development client built before this module existed would otherwise crash at
 * launch. Without it, import keeps its in-memory path and its 64 MB ceiling.
 */
export default requireOptionalNativeModule<StarkeepMediaHash>("StarkeepMediaHash");
