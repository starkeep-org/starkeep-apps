/**
 * The JavaScript face of {@link StarkeepMediaHashModule}.
 *
 * One call and no state. `src/platform.ts` adapts it to the import loop's
 * `HashUri`, where the decision about which assets use it lives and is tested.
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
}

/**
 * Null when the native module is not in the binary.
 *
 * Optional rather than required for the reason `starkeep-timer` gives: a
 * development client built before this module existed would otherwise crash at
 * launch. Without it, import keeps its in-memory path and its 64 MB ceiling.
 */
export default requireOptionalNativeModule<StarkeepMediaHash>("StarkeepMediaHash");
