/**
 * The JavaScript face of {@link StarkeepAvifModule}.
 *
 * One call and no state: hand it a decoded image and a path, and AVIF bytes
 * appear at that path. Everything built on top of it — which rungs a record
 * needs, what they are called, where their bytes end up — lives in
 * `src/photos/derive-ladder.ts`, where it can be tested without a handset.
 *
 * ## Why the source is typed as an `ImageRef`
 *
 * The native side declares `SharedRef<Drawable>` and deliberately does not
 * depend on expo-image, so it accepts any module's shared reference to a
 * drawable. This app produces exactly one kind — `Image.loadAsync`'s — and
 * naming it here is what makes a wrong argument a compile error rather than an
 * `IncorrectRefTypeException` on a device. The import is type-only and erases,
 * so it adds no dependency in either direction.
 */

import { requireOptionalNativeModule } from "expo";
import type { ImageRef } from "expo-image";

/** What one encode produced. The bytes are at the path the caller supplied. */
export interface AvifEncodeResult {
  /** The encoded image's dimensions, after the long-edge cap was applied. */
  readonly width: number;
  readonly height: number;
  /** Length of the file written. */
  readonly bytes: number;
}

export interface StarkeepAvif {
  /**
   * Encode `source` as AVIF at no more than `maxLongEdge`, writing to `path`.
   *
   * Never upscales: an image already inside `maxLongEdge` is encoded at its own
   * size, which is rule 1 of the ladder. `quality` is on libavif's 0–100 scale,
   * the same one `derive-ladder.ts` hands `sharp` on a node.
   *
   * The path is where the caller wants the bytes, and its parent directories are
   * created if they do not exist. Nothing is read back here — the caller does
   * that, because it is the caller that has to hash them.
   */
  encodeAsync(
    source: ImageRef,
    path: string,
    maxLongEdge: number,
    quality: number,
  ): Promise<AvifEncodeResult>;
}

/**
 * Null when the native module is not in the binary.
 *
 * Optional rather than required, for the reason `starkeep-timer` gives: a
 * development client built before this module existed would otherwise crash on
 * the first import in `platform.ts` — at launch, on every path, for a module
 * that only matters when a background window derives something. A phone without
 * it behaves exactly as this app did before derivation existed, and the tick
 * report names the job it could not run.
 */
export default requireOptionalNativeModule<StarkeepAvif>("StarkeepAvif");
