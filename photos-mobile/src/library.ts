/**
 * The library: what this node holds, and how the UI asks about it.
 *
 * ## Why the grid stops reading the media store directly
 *
 * `MediaGrid` reads `expo-media-library` and shows whatever is on the device.
 * That was the right thing when the node held nothing — it made the app useful
 * with no account, no cloud and no import loop. But it shows the *device's*
 * photos, not the *node's*, and those stop being the same set the moment
 * anything syncs in from elsewhere or anything is imported and then removed
 * from the camera roll.
 *
 * So the library is the records, and the bytes are resolved per record through
 * object storage — which, on a phone that has imported its camera roll, means
 * straight back to the `content://` asset via the alias. The picture on screen
 * is the same picture; what changed is which question produced it.
 *
 * ## Renditions are not involved yet
 *
 * A tile renders the original. That is fine at this size and deliberately not a
 * long-term answer: it is what `import-loop-design.md` §3.2 defers until there
 * is a session, and what item 15a revisits when the grid becomes a real
 * virtualised list over 60k items rather than a wrapping row over a few dozen.
 */

import type { DataRecord } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type { MediaAliasStore } from "./media/media-alias";

/** One item as the UI needs it: a record, plus where to get a picture. */
export interface LibraryItem {
  readonly record: DataRecord;
  /**
   * A URI an `<Image>` can render, or null when the bytes are not on this
   * device.
   *
   * Null is a real and expected state, not an error — it is a record whose
   * blob is elided or still owed, and it is what a placeholder tile is for. A
   * grid that treated it as a failure would report the working case of a
   * budgeted phone as broken.
   */
  readonly uri: string | null;
}

export interface LibraryPage {
  readonly items: readonly LibraryItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface LibraryQuery {
  readonly limit: number;
  readonly cursor?: string;
}

/**
 * One page of the library, newest first.
 *
 * Newest first for the same reason `listRecentMedia` sorts that way: a library
 * opening on photos from years ago reads as the wrong library rather than the
 * wrong sort order, and nobody scrolls far enough to find out otherwise.
 */
export async function listLibrary(
  deps: { readonly database: DatabaseAdapter; readonly aliases: MediaAliasStore | null },
  query: LibraryQuery,
): Promise<LibraryPage> {
  const result = await deps.database.query({
    sort: [{ field: "created_at", direction: "desc" }],
    limit: query.limit,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    // Renditions are child records carrying `photos/rendition`. None exist yet,
    // but excluding them here rather than later means the grid does not start
    // showing thumbnails as separate items the day derivation lands.
    excludeLabel: { appId: "photos", key: "rendition" },
  });

  return {
    items: result.records.map((record) => ({ record, uri: uriFor(deps.aliases, record) })),
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
  };
}

/**
 * Where to read a record's picture from.
 *
 * Only the alias is consulted, deliberately. A blob in the node's own object
 * store is at a path this function could construct — but constructing it here
 * would put a second copy of the adapter's sharding rule in the UI layer, and
 * the day that rule changes the grid would go blank for reasons no one would
 * connect to a storage refactor. When such records exist (they arrive by sync,
 * which does not work yet) the honest fix is an adapter method that hands back
 * a readable URI, not a path guess.
 */
function uriFor(aliases: MediaAliasStore | null, record: DataRecord): string | null {
  if (!aliases || !record.objectStorageKey) return null;
  return aliases.get(record.objectStorageKey)?.contentUri ?? null;
}

/** What the node holds, for the status section. */
export interface LibrarySummary {
  readonly records: number;
  /** Bytes held by the device's media store on the node's behalf. */
  readonly aliasedBytes: number;
}

export async function summarizeLibrary(deps: {
  readonly database: DatabaseAdapter;
  readonly aliases: MediaAliasStore | null;
}): Promise<LibrarySummary> {
  // Counted by paging rather than by a `COUNT(*)`, because `DatabaseAdapter`
  // exposes no count and inventing one through the raw handle would put a
  // second SQL dialect assumption in the app. Fine at this size; a real number
  // belongs on the adapter when the library is big enough for it to matter.
  let records = 0;
  let cursor: string | null = null;
  do {
    const page: LibraryPage = await listLibrary(deps, { limit: 500, ...(cursor ? { cursor } : {}) });
    records += page.items.length;
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor);

  return { records, aliasedBytes: deps.aliases?.totalBytes() ?? 0 };
}
