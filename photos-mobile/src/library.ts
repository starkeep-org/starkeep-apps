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
 * ## What a tile paints
 *
 * A rendition when one exists, and the record's own bytes when none does.
 *
 * Falling back to the original is right on a phone in a way it is not in a
 * browser: the bytes are already on the device, because this node imported them
 * from its own camera roll, so there is no download to avoid — only a decode.
 * What the rendition buys here is the decode, and 40 megapixels decoded into a
 * 180 px tile is a real cost even with the file sitting locally.
 *
 * Which rendition is Photos' question, answered above the platform in
 * `photos/renditions.ts`. Nothing in this file names a size class.
 */

import type { DataRecord, StarkeepId } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { MediaAliasStore } from "./media/media-alias";
import { renditionToPaint, resolveLibraryRenditions } from "./photos/renditions";

/**
 * What the library needs to answer a question about this node.
 *
 * `objectStorage` is the node's own overlay — the alias table and the file store
 * together — which is what makes one lookup cover both an imported photo that
 * was never copied and a blob that arrived by sync or an on-demand fetch.
 */
export interface LibraryDeps {
  readonly database: DatabaseAdapter;
  readonly objectStorage: ObjectStorageAdapter;
  readonly aliases: MediaAliasStore | null;
}

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
  /**
   * The pixel long edge a tile wants, so the page can resolve which rendition
   * answers it.
   *
   * In pixels, never a class name — the same contract every other Photos
   * surface uses, and what lets the ladder be respecified without touching a
   * caller. Omitted means "the original", which is what a caller wanting the
   * full-size picture asks for.
   */
  readonly tileLongEdge?: number;
}

/**
 * One page of the library, newest first.
 *
 * Newest first for the same reason `listRecentMedia` sorts that way: a library
 * opening on photos from years ago reads as the wrong library rather than the
 * wrong sort order, and nobody scrolls far enough to find out otherwise.
 */
export async function listLibrary(
  deps: LibraryDeps,
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

  // One resolution for the whole page, which is what makes it affordable: the
  // children of every record on the page come back in one query rather than one
  // per tile.
  const target = query.tileLongEdge;
  const renditions = target
    ? await resolveLibraryRenditions(deps.database, result.records, [target])
    : null;

  // The renditions a tile may paint are child records, and the page query
  // excluded them — so their rows are fetched here, once, by id.
  const chosen = new Map<StarkeepId, StarkeepId>();
  if (renditions && target) {
    for (const record of result.records) {
      const paint = renditionToPaint(renditions.get(record.id)?.[String(target)]);
      if (paint) chosen.set(record.id, paint.id as StarkeepId);
    }
  }
  const renditionRows = new Map<StarkeepId, DataRecord>();
  if (chosen.size > 0) {
    const found = await deps.database.query({
      filters: [{ field: "id", operator: "in", value: [...chosen.values()] }],
      limit: chosen.size,
    });
    for (const row of found.records) renditionRows.set(row.id, row);
  }

  return {
    items: result.records.map((record) => {
      const renditionId = chosen.get(record.id);
      const rendition = renditionId ? renditionRows.get(renditionId) : undefined;
      // The rendition when its bytes are actually here. A record whose
      // rendition is known but not yet fetched still has its original on this
      // device, and showing that beats showing a placeholder.
      const renditionUri = rendition ? uriFor(deps.objectStorage, rendition) : null;
      return {
        record,
        uri: renditionUri ?? uriFor(deps.objectStorage, record),
      };
    }),
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
  };
}

/**
 * Where to read a record's picture from.
 *
 * Asked of the object store rather than reconstructed here. `localFileUriFor` is
 * the adapter's own answer to "name a file holding these bytes", and on this
 * node the store is the overlay — so one call covers an imported photo still
 * living in the camera roll (through the alias) and a blob that arrived by sync
 * or was fetched on demand (in the file store).
 *
 * Reading the alias table directly, as this used to, meant a record whose bytes
 * had genuinely landed still rendered as a placeholder — which would have made
 * the on-demand fetch look broken at the exact moment it started working.
 *
 * Null stays a real and expected answer: a record whose blob is elided or still
 * owed has no file to name, and that is what a placeholder tile is for.
 */
function uriFor(objectStorage: ObjectStorageAdapter, record: DataRecord): string | null {
  if (!record.objectStorageKey) return null;
  return objectStorage.localFileUriFor?.(record.objectStorageKey) ?? null;
}

/** What the node holds, for the status section. */
export interface LibrarySummary {
  readonly records: number;
  /** Bytes held by the device's media store on the node's behalf. */
  readonly aliasedBytes: number;
}

export async function summarizeLibrary(deps: LibraryDeps): Promise<LibrarySummary> {
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
