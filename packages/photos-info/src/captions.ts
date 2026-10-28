/**
 * A photo's caption, as both Photos apps store it.
 *
 * The caption lives in Photos' private table `image_enriched`, one row per
 * record, beside the title and the date-taken override. An empty caption
 * stores null rather than deleting the row, because the row may still hold
 * the other two.
 */

/** The longest caption either app stores. */
export const MAX_CAPTION_LENGTH = 2000;

/** Photos' app id, which names its private channel and its tables. */
export const PHOTOS_APP_ID = "photos";

/** The private table that holds captions. */
export const CAPTIONS_TABLE = "image_enriched";

/**
 * The value to store for a caption the person typed: null for an empty one.
 * Throws for one longer than {@link MAX_CAPTION_LENGTH}.
 */
export function captionValue(caption: string): string | null {
  if (caption.length > MAX_CAPTION_LENGTH) {
    throw new RangeError(`A caption may be at most ${MAX_CAPTION_LENGTH} characters`);
  }
  return caption === "" ? null : caption;
}
