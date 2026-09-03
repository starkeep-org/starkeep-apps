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

import { typeCategory, type DataRecord, type StarkeepId } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, ObjectStorageAdapter, SortField } from "@starkeep/storage-adapter";
import type { MediaAliasStore } from "./media/media-alias";
import type { MotionIndexStore } from "./media/motion-index";
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
  /**
   * The motion index, when this node has one.
   *
   * Null is an ordinary state rather than a degraded one: a page with no index
   * marks no tile as a Motion Photo, which is the same answer it gives for a
   * photograph nobody has scanned yet. Nothing else on the tile depends on it.
   */
  readonly motionIndex?: MotionIndexStore | null;
}

/** One item as the UI needs it: a record, plus where to get a picture. */
export interface LibraryItem {
  readonly record: DataRecord;
  /**
   * A URI an `<Image>` can render, or null when this device holds no bytes to
   * render from.
   *
   * Null is a real and expected state, not an error: it means the record's blob
   * is elided or still owed and no rendition stands in for it. A grid that
   * treated that as a failure would report the working case of a budgeted phone
   * as broken.
   *
   * A video is not one of the null cases. `expo-image` paints a video's first
   * frame, so a clip whose bytes are here has a picture like any still — see the
   * settled note beside the assignment below.
   */
  readonly uri: string | null;
  /**
   * Whether this record's **own** bytes are on this device.
   *
   * Carried separately from {@link uri} because a non-null `uri` does not imply
   * it: a record whose original is elided still paints, from the rendition that
   * stands in for it. This field is the one that answers whether the full-size
   * file is here — which is what decides whether a video can be played and
   * whether the viewer offers the original at all.
   */
  readonly bytesHere: boolean;
  /**
   * A URI a video player can open, or null when this record is not a video or
   * its bytes are not on this device.
   *
   * A third field rather than a widening of {@link uri}, because the two ask
   * different questions and get different answers for the same record. `uri`
   * may name a poster rendition — a still, which a player handed it plays
   * nothing from — and it is non-null for a video whose original is elided,
   * which is exactly the video that cannot be played.
   */
  readonly playbackUri: string | null;
  /**
   * How long this video runs, in milliseconds, or null when nothing knows.
   *
   * Null for every still, and for a video whose bytes arrived by sync from a
   * node that recorded no duration. `formatDuration` renders the absence as the
   * word "video" rather than as `0:00`, because a zero-length clip describes a
   * broken file and the file is fine.
   */
  readonly durationMs: number | null;
  /**
   * Whether these bytes are known to hold a Motion Photo's clip.
   *
   * True only when the index says so. A photograph nobody has scanned reads
   * false, exactly like one scanned and found still — the flag drives a badge,
   * and a badge that appeared on unscanned tiles and vanished once they were
   * read would be worse than no badge. The viewer's own fallback scan still
   * finds motion on a record this returns false for, and offers playback there.
   */
  readonly hasMotion: boolean;
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
 * How the library is ordered.
 *
 * **By when the picture was taken, and only then by when it was imported.**
 * `created_at` alone — which is what this used to be — orders the grid by the
 * moment a record entered the node, and import walks the camera roll
 * oldest-first. So every batch of old photographs took the top of the grid and
 * pushed the recent ones down; tapping "Add photos from this device" made
 * yesterday's pictures harder to find, which is the opposite of what the control
 * promises.
 *
 * Newest first, for the same reason `listRecentMedia` sorts that way: a library
 * opening on photos from years ago reads as the wrong library rather than the
 * wrong sort order, and nobody scrolls far enough to find out otherwise.
 *
 * `created_at` stays as the second key rather than as a `COALESCE` fallback
 * inside the first, and the distinction is not cosmetic — the two values are not
 * comparable, so a record with no capture time cannot be interleaved with ones
 * that have it. It lands in a bucket at the end, ordered by import time. See
 * `record-queries.ts` in `@starkeep/storage-adapter` for why, and
 * `backfillImageExif` for what shrinks that bucket to nothing.
 */
const LIBRARY_ORDER: SortField[] = [
  { field: "capturedAt", direction: "desc" },
  { field: "createdAt", direction: "desc" },
];

/**
 * One page of the library, in {@link LIBRARY_ORDER}.
 */
export async function listLibrary(
  deps: LibraryDeps,
  query: LibraryQuery,
): Promise<LibraryPage> {
  const result = await deps.database.query({
    sort: LIBRARY_ORDER,
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

  // One query for the page's videos, never one per tile — the same argument the
  // rendition resolution above makes. A page of sixty stills issues none at all.
  const videoIds = result.records
    .filter((record) => typeCategory(record.type) === "video")
    .map((record) => record.id);
  const videoMetadata =
    videoIds.length > 0 ? await deps.database.getMetadataByIds("video", videoIds) : null;

  // One query for the page's stills, on the same argument. A Motion Photo is an
  // image record, so videos are not asked about at all.
  const motionKeys = result.records
    .filter((record) => typeCategory(record.type) === "image" && record.objectStorageKey)
    .map((record) => record.objectStorageKey as string);
  const withMotion = deps.motionIndex?.withMotion(motionKeys) ?? null;

  return {
    items: result.records.map((record) => {
      const renditionId = chosen.get(record.id);
      const rendition = renditionId ? renditionRows.get(renditionId) : undefined;
      // The rendition when its bytes are actually here. A record whose
      // rendition is known but not yet fetched still has its original on this
      // device, and showing that beats showing a placeholder.
      const renditionUri = rendition ? uriFor(deps.objectStorage, rendition) : null;
      const ownUri = uriFor(deps.objectStorage, record);
      // A video falls back to its own bytes exactly like a still does, because
      // `expo-image` paints a video's first frame.
      //
      // **Settled on a handset, 2026-09-02.** This line used to null the URI
      // for every video, on the claim that handing one to an `<Image>` paints
      // nothing. The claim was false, and `ui/MediaGrid.tsx` was the standing
      // counter-example the whole time: the device grid hands exactly such a
      // URI to the same `expo-image` and has always drawn frames. Under
      // Android, `expo-image` is Glide, and Glide decodes a frame from a local
      // video through `MediaMetadataRetriever` — it sniffs the source rather
      // than trusting a file extension, which is what makes an extensionless
      // synced blob work as well as a camera-roll `content://` asset.
      //
      // Nulling it here was what made a library tile a black square where the
      // device tile beside it, drawn from the same file, showed a picture. It
      // is also what would have justified building the poster cache in
      // workstream C5 of
      // `plan-photos-mobile-video-and-foreground-sync-2026-09-02.md`; that cache
      // is not needed and is not built.
      const isVideo = typeCategory(record.type) === "video";
      const duration = videoMetadata?.get(record.id)?.["duration_ms"];
      return {
        record,
        uri: renditionUri ?? ownUri,
        bytesHere: ownUri !== null,
        // The record's own bytes, never the rendition's: a poster is a still and
        // a player handed one plays nothing. `localFileUriFor` already covers
        // both the camera-roll asset behind an alias and a blob fetched from the
        // cloud, so one call names a playable file for either.
        playbackUri: isVideo ? ownUri : null,
        durationMs: typeof duration === "number" ? duration : null,
        hasMotion:
          record.objectStorageKey !== undefined &&
          (withMotion?.has(record.objectStorageKey) ?? false),
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
  // One `COUNT(*)`, not a walk. This used to page the whole library five
  // hundred records at a time to put one number on screen — through the very
  // cursor whose correctness the number is supposed to be independent of, so a
  // library larger than one page reported a total that depended on how the ids
  // happened to sort. The adapter answers counts now, which is where the old
  // comment here said the number belonged.
  //
  // The same `excludeLabel` the page query carries, so the count and the grid
  // agree about what a record is: a rendition is a child record, and counting
  // it would report five numbers for every photograph.
  const records = await deps.database.countRecords({
    excludeLabel: { appId: "photos", key: "rendition" },
  });

  return { records, aliasedBytes: deps.aliases?.totalBytes() ?? 0 };
}
