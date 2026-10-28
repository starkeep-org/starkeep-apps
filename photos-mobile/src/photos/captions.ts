/**
 * A photo's caption, read and written on this phone.
 *
 * Captions live in Photos' private table `image_enriched`, which syncs on
 * Photos' own channel. Writes go through the platform's app-specific view, the
 * same code the desktop's data server runs, so a caption written here is
 * stamped with this node's clock and ships like one written on the desktop.
 *
 * ## Why editing waits for the first pull
 *
 * The applier resolves conflicts per row, and a scan ships whole rows. A phone
 * that captions a photo before it has pulled that photo's row writes a row with
 * no title and no date override, and its newer timestamp then blanks both on
 * every device. So editing waits until the Photos channel has completed a pull
 * (decision 7 of `plan-mobile-private-channel-and-captions-2026-10-27.md`).
 */

import type { AppSpecificOperations } from "@starkeep/shared-space-api";
import { CAPTIONS_TABLE, MAX_CAPTION_LENGTH, captionValue } from "@starkeep/photos-info";

export { MAX_CAPTION_LENGTH };

export interface CaptionStore {
  /** The photo's caption, or null when it has none. */
  get(recordId: string): Promise<string | null>;
  /**
   * Store the photo's caption, as typed: an empty one clears it. Resolves the
   * stored value. Throws when editing is not allowed yet, or for a caption
   * over {@link MAX_CAPTION_LENGTH}.
   */
  set(recordId: string, caption: string): Promise<string | null>;
  /** Why editing is not allowed yet, or null when it is. */
  editBlockedReason(): string | null;
}

/** Thrown by {@link CaptionStore.set} while {@link CaptionStore.editBlockedReason} is not null. */
export class CaptionEditBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CaptionEditBlockedError";
  }
}

export function createCaptionStore(options: {
  /** Photos' app-specific view, or null when the node has no Photos namespace. */
  readonly view: AppSpecificOperations | null;
  /** Whether this node syncs with a cloud at all. */
  readonly hasCloud: boolean;
  /** Whether the Photos channel has completed a pull. */
  readonly pulled: () => boolean;
  /** A caption was written; the channel should ship it. */
  readonly onWrite?: () => void;
}): CaptionStore {
  const { view } = options;

  function editBlockedReason(): string | null {
    if (view === null) return "Captions are not set up on this phone.";
    if (!options.hasCloud) return "Sign in to edit captions.";
    if (!options.pulled()) return "Captions can be edited once this phone has synced them.";
    return null;
  }

  return {
    async get(recordId) {
      if (view === null) return null;
      const result = await view.query(CAPTIONS_TABLE, {
        where: JSON.stringify({ record_id: recordId }),
        select: "caption",
        limit: "1",
      });
      if (result.mode !== "rows") return null;
      const caption = result.rows[0]?.["caption"];
      return typeof caption === "string" ? caption : null;
    },

    async set(recordId, caption) {
      const reason = editBlockedReason();
      if (reason !== null || view === null) throw new CaptionEditBlockedError(reason ?? "");
      const value = captionValue(caption);
      // A partial upsert: the row's title and date override keep their values.
      await view.insertRow(CAPTIONS_TABLE, { record_id: recordId, caption: value });
      options.onWrite?.();
      return value;
    },

    editBlockedReason,
  };
}
