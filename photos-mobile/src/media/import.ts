/**
 * The import loop: turning the device's camera roll into records the node holds.
 *
 * ## What import does and does not do
 *
 * It creates a shared image record per asset and an alias saying where that
 * record's bytes already are. It does **not** copy the bytes. The MediaStore
 * asset is the local copy, on the argument that a photos app which silently
 * doubles a 60 GB camera roll on an 8 GB device has misunderstood its job. See
 * `import-loop-design.md` §1–2 and `media-alias.ts`.
 *
 * It also does not derive renditions. That is `derive-ladder`, it is gated on
 * this node having a session, and the reasoning is §3.2 of the same document:
 * before there is anywhere to send them, the device's own grid renders from
 * MediaStore and nothing reads a rendition.
 *
 * ## The unavoidable cost
 *
 * Content-addressed keys mean the original must be read end-to-end once, to
 * SHA-256 it. That is a read and not a copy — nothing is written — but on a
 * 60k-item library it is real work, which is why this is per-asset and
 * resumable rather than a library-wide pass. `scan-media-store` in the job
 * graph declares 2 seconds per unit, and a unit is one asset.
 *
 * ## Two-phase, so a kill between the writes is recoverable
 *
 * A phone is killed whenever the OS likes, including between the alias write
 * and the record write. So the order is deliberate: **alias first, record
 * second**, and re-import is decided by whether the *record* exists rather
 * than whether the alias does.
 *
 * - Killed after the alias, before the record: next scan finds the alias,
 *   looks up its `recordId`, finds nothing, and re-imports. The content hash
 *   is the same, so the same alias row is upserted onto the new record id.
 * - Killed after both: next scan finds alias and record and skips.
 *
 * The rejected order is record-first: a record whose blob key nothing aliases
 * reads as `staged` — bytes wanted, not here — and a re-scan would not find it
 * from the asset side, so it would mint a *second* record for the same photo
 * and leave the first one permanently owed bytes that exist one row away.
 */

import {
  createDataRecord,
  dataRecordObjectKey,
  defaultTypeForExtension,
  type DataRecord,
  type HLCClock,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type { ExpoFileSystem } from "../storage/expo-object-storage";
import { streamFromFile } from "../storage/expo-object-storage";
import { listRecentMedia, type DeviceMediaItem, type DeviceMediaModule } from "./device-library";
import type { MediaAliasStore } from "./media-alias";

/**
 * An incremental SHA-256, supplied by the app's edge.
 *
 * Declared here rather than imported so this module and its tests run in Node:
 * the same rule the storage adapter, the op-sqlite driver and the media module
 * all follow. `@starkeep/storage-adapter` exports the matching `HashFactory`
 * type and ships a portable default, so the edge has something to hand over.
 */
export interface IncrementalHash {
  update(chunk: Uint8Array): void;
  digestHex(): string;
}

export type HashFactory = () => IncrementalHash;

export interface ImportDeps {
  readonly media: DeviceMediaModule;
  readonly aliases: MediaAliasStore;
  readonly database: DatabaseAdapter;
  readonly clock: HLCClock;
  /** The same filesystem port everything else uses; content URIs go through it. */
  readonly fs: ExpoFileSystem;
  readonly hash: HashFactory;
  /** Injected so tests can assert `addedAtMs` rather than tolerate it. */
  readonly now?: () => number;
}

export interface ImportOptions {
  /** How many assets to consider this run. A unit of work, not a page size. */
  readonly limit: number;
  /**
   * The app claiming origin on the records.
   *
   * `photos` by default because this is the photos app, and origin attribution
   * is what §4.2 of the media plan makes derivation ownership out of: the node
   * that ingested an original is the one that derives from it.
   */
  readonly originAppId?: string;
}

/** What one import pass did, per asset, so a caller can report rather than guess. */
export interface ImportOutcome {
  readonly scanned: number;
  readonly imported: number;
  /** Already imported and unchanged. */
  readonly skipped: number;
  /** Considered and could not be read — counted, never thrown. */
  readonly failed: number;
  readonly records: readonly DataRecord[];
}

/**
 * Import one batch of the device's most recent media.
 *
 * A single unreadable asset never fails the pass. The media store can hand back
 * an id whose bytes are on an unmounted volume or were deleted between the
 * query and the read, and abandoning 59,999 photos because of one of them is
 * not a behaviour anyone wants on a phone.
 */
export async function importDeviceMedia(
  deps: ImportDeps,
  options: ImportOptions,
): Promise<ImportOutcome> {
  const now = deps.now ?? Date.now;
  const originAppId = options.originAppId ?? "photos";
  const items = await listRecentMedia(deps.media, { limit: options.limit });

  const records: DataRecord[] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of items) {
    try {
      if (await alreadyImported(deps, item)) {
        skipped += 1;
        continue;
      }
      const record = await importOne(deps, item, { originAppId, nowMs: now() });
      if (!record) {
        failed += 1;
        continue;
      }
      records.push(record);
      imported += 1;
    } catch {
      // Same argument as the skip inside `listRecentMedia`: one asset the media
      // store cannot produce costs one record, and throwing would cost the run.
      failed += 1;
    }
  }

  return { scanned: items.length, imported, skipped, failed, records };
}

/**
 * Whether this asset is already a record with its bytes accounted for.
 *
 * Three conditions, and all three are load-bearing:
 *
 * 1. An alias exists for the asset — otherwise it was never imported.
 * 2. The media store's mtime still matches the one recorded at import. An edit
 *    in place keeps the asset id and changes the bytes, which would leave the
 *    record's content hash describing bytes that no longer exist.
 * 3. The record the alias names is actually stored — the crash window above.
 */
async function alreadyImported(deps: ImportDeps, item: DeviceMediaItem): Promise<boolean> {
  const alias = deps.aliases.byAssetId(item.id);
  if (!alias) return false;
  if (alias.modificationTimeMs !== item.modifiedAt) return false;
  return (await deps.database.get(alias.recordId)) !== null;
}

async function importOne(
  deps: ImportDeps,
  item: DeviceMediaItem,
  context: { readonly originAppId: string; readonly nowMs: number },
): Promise<DataRecord | null> {
  const file = deps.fs.file(item.uri);
  if (!file.exists) return null;

  const digest = await hashFile(deps, item.uri);
  if (!digest) return null;

  const type = typeOf(item);
  const objectStorageKey = dataRecordObjectKey(type, digest.hex);

  const record = createDataRecord(
    {
      type,
      originAppId: context.originAppId,
      contentHash: digest.hex,
      objectStorageKey,
      sizeBytes: digest.sizeBytes,
      originalFilename: item.filename,
    },
    deps.clock,
  );

  // Alias first. See the two-phase note in this file's header — this order is
  // the one whose interrupted state is recoverable.
  deps.aliases.add({
    objectStorageKey,
    recordId: record.id,
    contentUri: item.uri,
    assetId: item.id,
    sizeBytes: digest.sizeBytes,
    contentType: null,
    modificationTimeMs: item.modifiedAt,
    addedAtMs: context.nowMs,
  });

  await deps.database.put(record);
  return record;
}

/**
 * SHA-256 the asset by streaming it, counting bytes as it goes.
 *
 * Streamed rather than read whole for the obvious reason and one less obvious
 * one: a 4K video is hundreds of megabytes, and materialising it to hash it
 * would OOM the app on exactly the files whose originals matter most.
 *
 * The size comes from the stream rather than from the media store's metadata
 * because it is what the alias's staleness check is later compared against —
 * taking it from a different source than the bytes were read from is how a
 * check comes to pass against a file it never examined.
 */
async function hashFile(
  deps: ImportDeps,
  uri: string,
): Promise<{ hex: string; sizeBytes: number } | null> {
  const stream = streamFromFile(deps.fs.file(uri));
  if (!stream) return null;

  const hash = deps.hash();
  let sizeBytes = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        hash.update(value);
        sizeBytes += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { hex: hash.digestHex(), sizeBytes };
}

/**
 * The record's Starkeep type, from the filename's extension.
 *
 * Extension rather than the media store's `mediaType`, because `mediaType` is
 * `image` — a category, not a type, and `image/heic` versus `image/jpeg` is
 * precisely the distinction derivation ownership turns on (§4.2: the cloud
 * fallback cannot decode HEIC). Falling back to the category loses exactly the
 * information that matters.
 */
function typeOf(item: DeviceMediaItem): string {
  const ext = item.filename?.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  if (ext) return defaultTypeForExtension(ext);
  // No filename and therefore no extension. `other/binary` is what
  // `defaultTypeForExtension` answers for anything unrecognised, and letting it
  // say so keeps one rule for "we do not know" instead of two.
  return defaultTypeForExtension("");
}
