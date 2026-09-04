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

import {
  typeCategory,
  type DataRecord,
  type MetadataRow,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, ObjectStorageAdapter, SortField } from "@starkeep/storage-adapter";
import type { MediaAliasStore } from "./media/media-alias";
import type { MotionIndexStore } from "./media/motion-index";
import {
  dimensionsFromMetadata,
  resolveLibraryRenditions,
  resolveRecordRenditions,
} from "./photos/renditions";
// Photos' own layer, which is where a size class or a ladder rung may be named.
// This file may not import `@starkeep/photos-ladder` directly and does not — see
// `__tests__/ladder-boundary.test.ts`. What comes through here is a pixel count
// and a width-over-height ratio, neither of which is ladder vocabulary.
import {
  displayedAspectOf,
  gridTileTarget,
  viewerTarget,
  type Dimensions,
  type GridGeometry,
} from "./photos/render-target";

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
  /**
   * The width-over-height ratio this record is *shown* at.
   *
   * Displayed, not stored: a quarter-turn EXIF orientation swaps the two, and
   * the media store's own columns carry no rotation correction — which is why
   * `media/exif.ts` reads the header at all. Always a number, because a
   * justified row needs a box for every item and a record whose dimensions
   * nothing has read yet must take a plausible slot rather than gapping the
   * grid. See `displayedAspectOf`.
   */
  readonly aspect: number;
  /**
   * The ~25-byte placeholder this record paints before anything resolves, or
   * null.
   *
   * Base64, handed to `expo-image` as `placeholder={{ thumbhash }}` and decoded
   * natively — no JavaScript decode and no data URL per tile. **This is the
   * floor of the paint rule:** with one of these, no surface ever draws an empty
   * rectangle. Null is the transitional state that `backfillThumbHashes` exists
   * to remove.
   */
  readonly thumbHash: string | null;
  /**
   * The rung this surface wants whose bytes are not on this device, or null.
   *
   * Null is the ordinary answer: the ideal is already here, or the ladder names
   * no ideal to fetch. Non-null is the one thing that used to be silently
   * dropped — the phone resolved which rung it wanted, found the bytes absent,
   * and painted the original instead without ever asking for the rung. See
   * `fetchRendition` in `ui/use-library.ts`.
   */
  readonly missingRendition: StarkeepId | null;
  /**
   * The rendition actually being painted, or null when nothing is.
   *
   * Two callers need it and neither can derive it from {@link uri}. The
   * eviction order needs it — `noteOpened` on the parent alone leaves a rung
   * painted from disk looking untouched, so the LRU evicts the very rendition
   * the grid is drawing from. And the tile's fetch rule needs it: a tile fires a
   * request only when it has *no* resident rung at all, because a grid that
   * issued one per tile per scroll would be a request storm, and the rungs the
   * sync prefetches exist so the grid draws from disk.
   *
   * Null with a non-null `uri` is the ordinary phone case: the original is here,
   * so the tile paints the full-size file and no rendition is involved.
   */
  readonly paintedRendition: StarkeepId | null;
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
   * The grid this page will be laid out in, so each record can be sized for the
   * box it is about to get.
   *
   * **Geometry, not a pixel count, and the difference is the whole of Part 3.**
   * This used to be one `tileLongEdge` for a whole page, which was right only
   * while the grid was a fixed three-column square crop. A justified row gives
   * every photograph a box of its own shape, so a portrait tile and a panorama
   * in the same row want different numbers of pixels — and the target has to be
   * derived per record from the shape rather than stated once per page. See
   * `photos/render-target.ts`.
   *
   * Omitted means "resolve nothing", which is what a caller wanting the
   * full-size original asks for.
   */
  readonly grid?: GridGeometry;
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
 *
 * ## What each item comes back with
 *
 * Enough to draw the tile without asking anything else: the shape it is laid out
 * in, the placeholder it paints before its bytes resolve, the rendition it
 * should paint when there is one, and the rung it wants but has not got. Four
 * queries serve the whole page — the records, their children, their image
 * metadata and their video metadata — and none of them is per tile. A grid that
 * issued a query per tile would issue one per tile per scroll.
 */
export async function listLibrary(
  deps: LibraryDeps,
  query: LibraryQuery,
): Promise<LibraryPage> {
  const result = await deps.database.query({
    sort: LIBRARY_ORDER,
    limit: query.limit,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    // Renditions are child records carrying `photos/rendition`. Excluding them
    // here rather than later means the grid does not show thumbnails as separate
    // items now that this device derives some of its own.
    excludeLabel: { appId: "photos", key: "rendition" },
  });

  return {
    items: await resolveLibraryItems(deps, result.records, query.grid ?? null),
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
  };
}

/**
 * The records of one page, turned into what a grid draws.
 *
 * Split out of {@link listLibrary} so that re-deriving *one* record goes through
 * exactly this code — see {@link refreshLibraryItem}. The alternative was the
 * one this replaced: a rendition arriving re-listed and re-resolved the whole
 * loaded library to change a single tile, which on a Pixel 5 cost 5.8 s with the
 * JavaScript thread held, and did it once per arriving rendition.
 *
 * Every query it issues is per call and never per record, which is what makes
 * the page affordable and the single-record case cheap for the same reason.
 */
export async function resolveLibraryItems(
  deps: LibraryDeps,
  records: readonly DataRecord[],
  grid: GridGeometry | null,
): Promise<LibraryItem[]> {
  // One read of the stills' metadata for the whole page, and it answers three
  // questions at once: the shape each record is laid out in, the placeholder it
  // paints, and the source long edge the rendition resolution measures against.
  // Reading it once here is why `resolveLibraryRenditions` takes dimensions
  // rather than fetching its own.
  const imageIds = records
    .filter((record) => typeCategory(record.type) === "image")
    .map((record) => record.id);
  const imageMetadata =
    imageIds.length > 0 ? await deps.database.getMetadataByIds("image", imageIds) : null;

  // The clips' own row, for the duration a tile badges and the placeholder a
  // clip paints. A page of sixty stills issues neither this query nor the one
  // above's video counterpart.
  const videoIds = records
    .filter((record) => typeCategory(record.type) === "video")
    .map((record) => record.id);
  const videoMetadata =
    videoIds.length > 0 ? await deps.database.getMetadataByIds("video", videoIds) : null;

  const metadataFor = (record: DataRecord): MetadataRow | undefined =>
    typeCategory(record.type) === "video"
      ? videoMetadata?.get(record.id)
      : imageMetadata?.get(record.id);

  const orientationOf = (record: DataRecord): number | null => {
    const value = imageMetadata?.get(record.id)?.["orientation"];
    return typeof value === "number" ? value : null;
  };
  const dimensionsOf = (record: DataRecord) => dimensionsFromMetadata(metadataFor(record));

  // Whether these bytes are on this device — asked of the object store, which is
  // the overlay, so one call covers a camera-roll asset behind an alias and a
  // blob that arrived by sync alike. This is what the resolution's second pass
  // filters on, and it is the distinction `RenditionChoice.available` cannot
  // make: that flag says the rendition *record* exists.
  const isResident = (key: string) => (deps.objectStorage.localFileUriFor?.(key) ?? null) !== null;

  const targetFor = (record: DataRecord): number | null => {
    if (!grid) return null;
    const dims = dimensionsOf(record);
    const source = dims && dims.width && dims.height
      ? { width: dims.width, height: dims.height }
      : null;
    return gridTileTarget(source, orientationOf(record), grid);
  };

  // One resolution for the whole page, which is what makes it affordable: the
  // children of every record on the page come back in one query rather than one
  // per tile.
  const renditions = grid
    ? await resolveLibraryRenditions(deps.database, records, {
        targetFor,
        isResident,
        dimensionsOf,
      })
    : null;

  // One query for the page's stills, on the same argument. A Motion Photo is an
  // image record, so videos are not asked about at all.
  const motionKeys = records
    .filter((record) => typeCategory(record.type) === "image" && record.objectStorageKey)
    .map((record) => record.objectStorageKey as string);
  const withMotion = deps.motionIndex?.withMotion(motionKeys) ?? null;

  return records.map((record) => {
    const resolved = renditions?.get(record.id) ?? null;
    // The rendition when its bytes are actually here — which is what `paint`
    // means, and why nothing here re-checks residency. A record whose ideal
    // rung is known but not yet fetched paints the largest resident rung below
    // it, and if there is none it paints its own original when that is here
    // and its ThumbHash when it is not.
    const renditionUri = resolved?.paint
      ? (deps.objectStorage.localFileUriFor?.(resolved.paint.objectStorageKey) ?? null)
      : null;
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
    const isVideo = typeCategory(record.type) === "video";
    const row = metadataFor(record);
    const duration = row?.["duration_ms"];
    const thumbHash = row?.["thumb_hash"];
    const dims = dimensionsOf(record);
    return {
      record,
      // **The original is deliberately still in this list, and it is the one
      // step the plan's paint rule does not have.** The rule says: the ideal
      // rung, else the largest resident rung below it, else the ThumbHash. On
      // a phone there is a fourth thing, and it is better than both fallbacks:
      // the full-size file, sitting in the camera roll this node imported it
      // from. There is no download to avoid — only a decode — so painting it
      // beats painting a placeholder for a picture the device already holds.
      //
      // It is last, after both rungs, because the decode is what the rungs
      // exist to avoid.
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
      aspect: displayedAspectOf(
        dims && dims.width && dims.height ? { width: dims.width, height: dims.height } : null,
        orientationOf(record),
      ),
      thumbHash: typeof thumbHash === "string" && thumbHash.length > 0 ? thumbHash : null,
      missingRendition: resolved?.missingIdeal ?? null,
      // The rendition only when it is the thing on screen. `renditionUri` is
      // null exactly when the rung's bytes are absent, and in that case the
      // tile fell through to the original — so nothing was painted from a
      // rendition and nothing about one should be recorded.
      paintedRendition: renditionUri ? (resolved?.paint?.id ?? null) : null,
    };
  });
}

/**
 * One record's tile, derived again after something changed underneath it.
 *
 * ## What this replaced
 *
 * A reload. `fetchRendition` used to answer an arriving rung by re-listing the
 * whole loaded library, on the argument that the URI is derived from the object
 * store and there should be exactly one code path that derives it. The argument
 * was right and the implementation was the wrong size: {@link
 * resolveLibraryItems} is that one code path, and handing it a single record
 * satisfies the argument without re-deriving the fifty-nine tiles that did not
 * change.
 *
 * The cost was not theoretical. On a Pixel 5 a two-page reload took 5.8 s with
 * the JavaScript thread held throughout, so every touch queued behind it — and
 * because the tile prefetch loop is keyed on the page it rebuilt, each arriving
 * rendition also restarted the loop that had asked for it.
 *
 * ## Why it answers null rather than the record it was given
 *
 * A record can be gone by the time the bytes for it arrive — evicted, or
 * removed by a sync round. Null says so, and the caller drops the tile rather
 * than splicing a stale one back into a page that had already lost it.
 */
export async function refreshLibraryItem(
  deps: LibraryDeps,
  recordId: StarkeepId,
  grid: GridGeometry | null,
): Promise<LibraryItem | null> {
  const record = await deps.database.get(recordId);
  if (!record) return null;
  const [item] = await resolveLibraryItems(deps, [record], grid);
  return item ?? null;
}

/**
 * The same item, resolved for a full screen instead of for a tile.
 *
 * ## Why the viewer resolves at all
 *
 * Because a tile's answer is the wrong size for it. Every field on a
 * {@link LibraryItem} that concerns renditions was computed against the box a
 * justified row assigned — a couple of hundred pixels — and opening a photograph
 * full screen wants five or ten times that. The viewer used to paint whatever
 * the grid had already chosen, so a full-screen photograph showed a 320 or 640
 * pixel rendition stretched across the display.
 *
 * ## Why it returns a whole item rather than a URI
 *
 * Because the two things that change together are the picture and the reason
 * there is not a better one. A viewer handed only a URI cannot tell "this is the
 * best rung there is" from "the right rung is on its way", and those need
 * different words on screen. Returning the item keeps one shape for both
 * surfaces, so the viewer draws from the same fields the tile does.
 *
 * ## Why this also fixes the stale open item
 *
 * The viewer holds the item it was opened with, and a fetch that lands changes
 * what the answer would be. Re-running this after one is what makes the viewer
 * stop reporting bytes as absent once they have arrived — the whole item is
 * recomputed from the store, by the same code that computed it the first time.
 */
export async function resolveForViewer(
  deps: LibraryDeps,
  item: LibraryItem,
  geometry: { readonly screen: Dimensions; readonly devicePixelRatio: number },
): Promise<LibraryItem> {
  const record = item.record;
  const category = typeCategory(record.type) === "video" ? "video" : "image";
  const row = (await deps.database.getMetadataByIds(category, [record.id])).get(record.id);
  const dims = dimensionsFromMetadata(row);
  const orientationValue = row?.["orientation"];
  const orientation = typeof orientationValue === "number" ? orientationValue : null;
  const source =
    dims && dims.width && dims.height ? { width: dims.width, height: dims.height } : null;

  const isResident = (key: string) => (deps.objectStorage.localFileUriFor?.(key) ?? null) !== null;
  const resolved = await resolveRecordRenditions(
    deps.database,
    record,
    viewerTarget(geometry.screen, source, orientation, geometry.devicePixelRatio),
    isResident,
    dims,
  );

  const renditionUri = resolved?.paint
    ? (deps.objectStorage.localFileUriFor?.(resolved.paint.objectStorageKey) ?? null)
    : null;
  const ownUri = uriFor(deps.objectStorage, record);

  return {
    ...item,
    // The same order the tile uses, and the rungs still come before the
    // original — which is the one thing that might look backwards here, since
    // the original is the better picture. It is not what the viewer is choosing
    // between: `image-medium` and above are visually indistinguishable at this
    // size and cost a fraction of the decode, and a 40-megapixel original
    // decoded on a phone is seconds of blank screen. The original stays as the
    // answer when no rung is resident, which on this device's own camera roll is
    // most of the time.
    uri: renditionUri ?? ownUri,
    bytesHere: ownUri !== null,
    playbackUri: typeCategory(record.type) === "video" ? ownUri : null,
    paintedRendition: renditionUri ? (resolved?.paint?.id ?? null) : null,
    missingRendition: resolved?.missingIdeal ?? null,
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
