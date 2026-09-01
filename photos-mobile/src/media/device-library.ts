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
  const rows = await media
    .newQuery()
    .orderBy({ key: options.order ?? "creationTime", ascending: false })
    .limit(options.limit)
    .exeForMetadata();

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
