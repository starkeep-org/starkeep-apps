/**
 * The device's own camera roll (item 13, the `MediaStore` half).
 *
 * ## Why this is the app's most important data source
 *
 * It needs no account, no cloud, no sync and no network. The media is already
 * on the handset; Android's permission is the whole of the access control for
 * it, and once the user grants that, everything here works forever offline.
 * That makes this the one part of the app that is unconditionally useful — see
 * the note on the sign-in gate in `App.tsx`.
 *
 * ## Why expo-media-library is not imported here
 *
 * Same rule the storage adapter and the op-sqlite driver follow: the module is
 * declared structurally and supplied at the app's edge, so the mapping and the
 * ordering below run in Node against a fake. A grid that silently showed the
 * *oldest* photos first is exactly the kind of bug that looks fine in a
 * screenshot, and there is no reason to need a handset to catch it.
 *
 * ## What the library's shape forces
 *
 * `Query.exeForMetadata()` returns everything cheaply *except* the URI, which
 * the library documents as a heavier per-asset lookup. On Android an asset's
 * `id` is already its `content://` URI, so the common case costs nothing; the
 * per-asset resolve is the fallback, and is why {@link listRecentMedia} can
 * drop a single unreadable asset without emptying the grid.
 */

import { REAL_TIMERS, withDeadline, type Timers } from "../deadline";

/**
 * Re-exported because this module's options carry one.
 *
 * The race and the platform implementation live in `deadline.ts`, so a caller
 * with a timer of its own — a background window, which cannot use the
 * platform's — has one place to reach for.
 */
export type { Timers };

/** What a permission response tells us, narrowed to what this app acts on. */
export interface MediaPermission {
  readonly granted: boolean;
  readonly canAskAgain: boolean;
  /** `limited` is Android 14+ / iOS 14+: the user picked specific items. */
  readonly accessPrivileges?: "all" | "limited" | "none";
}

/** One row of `Query.exeForMetadata()`. */
export interface AssetMetadataLike {
  readonly id: string;
  readonly filename: string | null;
  readonly mediaType: string;
  readonly width: number | null;
  readonly height: number | null;
  /**
   * A video's length in **milliseconds**, or null when the store recorded none.
   *
   * The unit is worth stating, because the older `Asset.duration` on this same
   * library is *seconds* and a reader who knows that one will assume this one
   * matches. It does not. `AssetMetadata` comes from the newer `Query` API,
   * whose Android mapper passes `MediaStore.*.DURATION` — already milliseconds
   * — through untouched, and whose iOS mapper multiplies `PHAsset.duration` by
   * a thousand on the way out. Both platforms therefore answer in milliseconds
   * here, and {@link DeviceMediaItem.durationMs} carries the value unconverted.
   *
   * Both mappers also answer null rather than zero for an asset they could not
   * measure, which is why zero is treated as "not known" wherever this is read.
   */
  readonly duration: number | null;
  readonly creationTime: number | null;
  /**
   * When the media store last saw these bytes change.
   *
   * Carried because import aliases a record's blob to this asset rather than
   * copying it (see `import-loop-design.md` §2), which makes "are these still
   * the bytes we hashed" a question the node has to be able to ask. The media
   * store is the only place that can answer it: a `content://` URI resolves to
   * a `ContentProviderFile`, whose `lastModified()` is unconditionally `null`.
   *
   * Null when the store recorded none, which is treated as "cannot be verified
   * by time" rather than "unchanged" — see {@link DeviceMediaItem.modifiedAt}.
   */
  readonly modificationTime: number | null;
}

export interface MediaQuery {
  orderBy(sort: { key: string; ascending?: boolean }): MediaQuery;
  limit(count: number): MediaQuery;
  /**
   * Keep only assets whose field is at or above a value.
   *
   * Wrapped because the cost of this query lives in the *rows it returns*, not
   * in the work of deciding about them: `exeForMetadata()` probes each returned
   * asset inside the media store, so the only way to make a repeated scan cheap
   * is to stop the store from producing rows the caller already knows about.
   * See `import-cursor.ts`.
   */
  gte(field: string, value: number): MediaQuery;
  /**
   * Keep only assets whose field is one of these values.
   *
   * Wrapped for one predicate — the media type. `Query.exeForMetadata()` builds
   * its cursor over **`MediaStore.Files`**, not over the image and video
   * collections, so an unfiltered query returns whatever the media store has
   * indexed. See {@link ListRecentOptions.mediaTypes}.
   */
  within(field: string, values: readonly string[]): MediaQuery;
  exeForMetadata(): Promise<AssetMetadataLike[]>;
}

/** The slice of expo-media-library this app uses. */
export interface DeviceMediaModule {
  getPermissions(): Promise<MediaPermission>;
  requestPermissions(): Promise<MediaPermission>;
  newQuery(): MediaQuery;
  /** The heavier per-asset URI lookup, used only when an id is not already one. */
  uriFor(id: string): Promise<string>;
}

export type MediaKind = "image" | "video" | "audio" | "unknown";

export interface DeviceMediaItem {
  readonly id: string;
  readonly uri: string;
  readonly filename: string | null;
  readonly kind: MediaKind;
  readonly width: number | null;
  readonly height: number | null;
  /**
   * A video's length in milliseconds, carried straight from the media store.
   *
   * No conversion happens on the way here, and that is a conclusion rather than
   * an omission — see {@link AssetMetadataLike.duration} for why both platforms
   * already answer in this unit.
   */
  readonly durationMs: number | null;
  readonly createdAt: number | null;
  /**
   * The alias staleness signal. Null means the media store recorded none, which
   * the import loop must read as "unverifiable", not as "unchanged".
   */
  readonly modifiedAt: number | null;
}

/**
 * What the app should do about the permission it has.
 *
 * `blocked` is split from `denied` because they need different words on screen:
 * one is answerable with a button, and the other can only be fixed in the
 * system settings — a prompt that does nothing is worse than a sentence
 * explaining why.
 */
export type MediaAccess = "granted" | "limited" | "denied" | "blocked";

export function describeAccess(permission: MediaPermission): MediaAccess {
  if (permission.granted) {
    // Treated as access, not as a problem: the user chose to share some of
    // their library, and that choice deserves a working grid of what they
    // shared rather than a nag about the rest.
    return permission.accessPrivileges === "limited" ? "limited" : "granted";
  }
  return permission.canAskAgain ? "denied" : "blocked";
}

function kindOf(mediaType: string): MediaKind {
  return mediaType === "image" || mediaType === "video" || mediaType === "audio"
    ? mediaType
    : "unknown";
}

/** Android ids are already `content://` URIs; iOS `ph://`. Anything else resolves. */
function idIsUri(id: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(id);
}

/**
 * A video's length as `m:ss`.
 *
 * Falls back to the word rather than `0:00` when the media store recorded no
 * duration, which it does for some formats: a tile claiming a zero-length video
 * describes a broken file, and the file is fine.
 */
export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "video";
  const total = Math.round(durationMs / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Which "newest" a caller means.
 *
 * The distinction is not cosmetic, and getting it wrong loses photographs
 * silently.
 *
 * `creationTime` is `MediaStore.DATE_TAKEN`, a fact about the **content** —
 * when the shutter fired. It is what a person means by the order of a camera
 * roll, and it is **nullable**: the media store fills it from the file's EXIF,
 * so an image that carries none has no value at all. Screenshots from the
 * system carry one; an image saved from a messaging app, downloaded, or copied
 * onto the device may not.
 *
 * `modificationTime` is `MediaStore.DATE_MODIFIED`, a fact about the **file** —
 * when these bytes last changed on this device. The media store always sets it.
 *
 * ## Why a sort turns into a filter
 *
 * Ordering alone would be harmless. Ordering *with a limit* is a window, and an
 * asset whose sort key is null sorts to the far end of it — behind every asset
 * that has one. On a roll of several thousand it is not merely last, it is
 * unreachable, and no later pass recovers it because every pass asks the same
 * question and gets the same answer.
 *
 * So a caller that must not miss anything cannot sort by a nullable key.
 */
export type RecentOrder =
  /** When the shutter fired. What a camera roll looks like. Nullable. */
  | "creationTime"
  /** When these bytes last changed here. Always present. */
  | "modificationTime";

export interface ListRecentOptions {
  readonly limit: number;
  /**
   * Defaults to `creationTime`, which is right for anything a person reads and
   * wrong for anything that must not miss an asset. See {@link RecentOrder}.
   */
  readonly order?: RecentOrder;
  /**
   * Keep only assets modified at or after this time, in milliseconds.
   *
   * Filters on `modificationTime` whatever {@link ListRecentOptions.order}
   * says, because the two questions are separate: a caller may want the newest
   * assets by shutter time and still only want the ones that have appeared here
   * since it last looked.
   *
   * Omitted means no floor, which is what a reader of a camera roll wants and
   * what import wants on the one pass that establishes a watermark.
   */
  readonly modifiedSinceMs?: number | null;
  /**
   * Oldest first rather than newest first.
   *
   * Exists for the one caller that walks *forwards* from a watermark. A window
   * of fixed size taken from the newest end cannot drain a backlog: setting the
   * watermark to the newest asset in the batch skips everything the limit cut
   * off, and setting it to the oldest re-offers the whole batch forever. Taken
   * from the oldest end the same window advances a watermark monotonically and
   * reaches every asset eventually. See `import-cursor.ts`.
   */
  readonly ascending?: boolean;
  /**
   * Which kinds of asset to return. Omitted means every kind the store indexes.
   *
   * **The default is wrong for anything that imports**, and the reason is not
   * visible from this app's side. `Query.exeForMetadata()` queries
   * `MediaStore.Files` rather than the image and video collections, so an
   * unfiltered result set contains whatever the media store has indexed —
   * including files belonging to other applications, under their own
   * `Android/media/` directories.
   *
   * Measured on a Pixel 5: a three-row window over the last twelve hours held
   * two photographs and one entry from WhatsApp's trash directory, carrying
   * `media_type = 0`, a null MIME type, a null size and no extension. Import has
   * nothing sensible to do with such a row — `typeOf` falls back to
   * `other/binary` and the bytes are not this app's to read — so the honest
   * thing is to never be offered it.
   */
  readonly mediaTypes?: readonly MediaKind[];
  /**
   * How long to wait for the media store before giving up, in milliseconds.
   *
   * **A promise that never settles is the failure this defends against**, not a
   * slow one. On a Pixel 5, in a process started for `SystemJobService` with no
   * activity, `exeForMetadata()` has been observed never to return: four minutes
   * in, the process held 4.5 seconds of CPU, every thread slept, the coroutine
   * dispatchers were idle and no I/O was outstanding. Nothing was computing and
   * nothing was blocked; the promise simply never resolved.
   *
   * A hang there is worse than a failure anywhere else in the tick, because the
   * call happens *before* the loop `ImportOptions.signal` guards, so no deadline
   * downstream of it can bound it. The window then dies holding a claim on the
   * process instead of reporting what it found.
   *
   * The underlying call cannot be cancelled, so the loser of this race stays
   * pending until the process ends. Accepted deliberately: a leaked coroutine in
   * a process the OS is about to reclaim costs nothing, and the alternative is a
   * window that reports nothing at all.
   */
  readonly timeoutMs?: number;
  /**
   * The timer the deadline runs on.
   *
   * Injected for the same reason every other dependency here is: so the
   * behaviour is decidable in Node. A test that had to wait out a real timeout
   * would be a test nobody runs.
   */
  readonly timers?: Timers;
}

/** Thrown when the media store did not answer inside the caller's deadline. */
export class MediaQueryTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`the media store did not answer within ${timeoutMs}ms`);
    this.name = "MediaQueryTimeout";
  }
}

/**
 * The most recent media on the device, newest first.
 *
 * Newest first is not a preference — a camera roll opening on photos from years
 * ago reads as the wrong library rather than the wrong sort order, and nobody
 * scrolls far enough to find out otherwise. Which *newest* is the caller's
 * choice, and {@link RecentOrder} explains why the choice matters.
 */
export async function listRecentMedia(
  media: DeviceMediaModule,
  options: ListRecentOptions,
): Promise<DeviceMediaItem[]> {
  let query = media
    .newQuery()
    .orderBy({ key: options.order ?? "creationTime", ascending: options.ascending ?? false });
  // Before the limit, and it has to be: a limit applied to an unfiltered set
  // takes the newest twenty assets and *then* discards the ones below the floor,
  // which returns nothing while costing everything. The filter is what keeps the
  // rows — and therefore the media store's per-asset probe — out of the result.
  if (typeof options.modifiedSinceMs === "number") {
    query = query.gte("modificationTime", options.modifiedSinceMs);
  }
  // Before the limit, like the floor above, and for a sharper reason: an
  // unwanted row inside the limit is a photograph pushed out of the window
  // entirely. See {@link ListRecentOptions.mediaTypes}.
  if (options.mediaTypes && options.mediaTypes.length > 0) {
    query = query.within("mediaType", options.mediaTypes);
  }
  const rows = await withDeadline(query.limit(options.limit).exeForMetadata(), {
    ms: options.timeoutMs,
    timers: options.timers ?? REAL_TIMERS,
    onExpiry: () => new MediaQueryTimeout(options.timeoutMs ?? 0),
  });

  const items: DeviceMediaItem[] = [];
  for (const row of rows) {
    let uri: string;
    if (idIsUri(row.id)) {
      uri = row.id;
    } else {
      try {
        uri = await media.uriFor(row.id);
      } catch {
        // One asset the media store cannot resolve — deleted between the query
        // and the read, or on an unmounted volume. Skipping it costs one tile;
        // letting it throw would cost the whole grid.
        continue;
      }
    }
    items.push({
      id: row.id,
      uri,
      filename: row.filename,
      kind: kindOf(row.mediaType),
      width: row.width,
      height: row.height,
      durationMs: row.duration,
      createdAt: row.creationTime,
      modifiedAt: row.modificationTime,
    });
  }
  return items;
}
