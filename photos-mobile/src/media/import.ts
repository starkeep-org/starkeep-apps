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
import { isContentUri, streamFromFile } from "../storage/expo-object-storage";
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
  /**
   * Called after each asset, with what it cost.
   *
   * Exists because "very slow" is not a diagnosis. Reading a `content://` asset
   * pulls it whole across JSI and then hashes it in JavaScript, and which of
   * those two dominates decides what is worth fixing — a question no amount of
   * reasoning settles as cheaply as measuring it on the device that is slow.
   */
  readonly onProgress?: (progress: ImportProgress) => void;
  /**
   * Yield between assets, so the JS thread is not held for the whole batch.
   *
   * Defaults to a real yield. Tests pass a no-op to stay synchronous, and the
   * reason it is injectable rather than unconditional is that a `setTimeout`
   * per asset in a suite of 200 tests is slower than the work being tested.
   */
  readonly yieldToUi?: () => Promise<void>;
}

/** One asset's cost, reported as the loop goes rather than at the end. */
export interface ImportProgress {
  readonly done: number;
  readonly total: number;
  readonly filename: string | null;
  readonly sizeBytes: number;
  /** Milliseconds pulling the bytes into JS. */
  readonly readMs: number;
  /** Milliseconds hashing them. */
  readonly hashMs: number;
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

/**
 * Why one asset did not make it in.
 *
 * Carried rather than counted, because the first version of this counted. When
 * every asset on a real device failed, the screen could say "60 could not be
 * read" and nothing else — the reason had been caught and dropped one frame
 * from where it was needed. A failure count with no failure is not a report.
 */
export interface ImportFailure {
  readonly assetId: string;
  readonly filename: string | null;
  readonly reason: string;
}

/** What one import pass did, per asset, so a caller can report rather than guess. */
export interface ImportOutcome {
  readonly scanned: number;
  readonly imported: number;
  /** Already imported and unchanged. */
  readonly skipped: number;
  /** Considered and could not be read — counted, never thrown. */
  readonly failed: number;
  /** One entry per failure, in the order they happened. */
  readonly failures: readonly ImportFailure[];
  readonly records: readonly DataRecord[];
}

/**
 * The largest asset this loop will read.
 *
 * A ceiling rather than a guess: `content://` assets cannot be streamed (see
 * `streamFromFile`), so hashing one means holding it in memory, and a 4K video
 * held whole is the OOM streaming exists to prevent. Above this the asset is
 * reported as deferred rather than attempted — a named limitation beats a
 * process death, and it is lifted by the native streaming read that item 13b
 * needs anyway.
 *
 * 256 MB covers essentially every still, including raw, and excludes the long
 * videos that would actually be dangerous.
 */
export const MAX_INLINE_READ_BYTES = 256 * 1024 * 1024;

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
  const failures: ImportFailure[] = [];
  let imported = 0;
  let skipped = 0;

  const fail = (item: DeviceMediaItem, reason: string) =>
    failures.push({ assetId: item.id, filename: item.filename, reason });

  const yieldToUi = deps.yieldToUi ?? (() => new Promise<void>((r) => setTimeout(r, 0)));

  for (const [index, item] of items.entries()) {
    try {
      if (await alreadyImported(deps, item)) {
        skipped += 1;
        continue;
      }
      // Between assets, not inside one: the JS thread is single, and holding it
      // for a whole batch is what made the button say "Adding…" and then freeze
      // — the frame that would have shown progress could never be drawn.
      await yieldToUi();

      const record = await importOne(deps, item, { originAppId, nowMs: now() });
      if ("reason" in record) {
        fail(item, record.reason);
        continue;
      }
      records.push(record.record);
      imported += 1;
      deps.onProgress?.({
        done: index + 1,
        total: items.length,
        filename: item.filename,
        sizeBytes: record.sizeBytes,
        readMs: record.readMs,
        hashMs: record.hashMs,
      });
    } catch (err) {
      // Same argument as the skip inside `listRecentMedia`: one asset the media
      // store cannot produce costs one record, and throwing would cost the run.
      // The reason is kept, because a count on its own cannot be acted on.
      fail(item, String(err));
    }
  }

  return { scanned: items.length, imported, skipped, failed: failures.length, failures, records };
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
): Promise<({ record: DataRecord } & Omit<ImportProgress, "done" | "total" | "filename">) | { reason: string }> {
  // `exists` and `size` are one `file` rather than two. On a content URI both
  // are content-resolver round trips — `exists()` literally opens an input
  // stream — and the old code built the file twice and asked twice.
  const file = deps.fs.file(item.uri);
  const size = file.size;
  if (size === null) {
    return { reason: `the media store has no readable asset at ${item.uri}` };
  }
  if (size > MAX_INLINE_READ_BYTES) {
    return {
      reason: `${size} bytes is larger than this device can hash without streaming (${MAX_INLINE_READ_BYTES})`,
    };
  }

  const digest = await hashFile(deps, item.uri);
  if (!digest) return { reason: `could not read the bytes of ${item.uri}` };

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
  return { record, sizeBytes: digest.sizeBytes, readMs: digest.readMs, hashMs: digest.hashMs };
}

/**
 * SHA-256 the asset by streaming it, counting bytes as it goes.
 *
 * Streamed where streaming is possible. It is not possible for a `content://`
 * asset (see `streamFromFile`), and for those the bytes are taken directly
 * rather than pushed through a `ReadableStream` first — wrapping an
 * already-materialised buffer in a stream only to read it back in chunks is
 * pure overhead on the hottest path in the app, and it is the path every
 * camera-roll photo takes.
 *
 * The size comes from the bytes actually read rather than from the media
 * store's metadata, because it is what the alias's staleness check is later
 * compared against — taking it from a different source than the bytes were
 * read from is how a check comes to pass against a file it never examined.
 */
async function hashFile(
  deps: ImportDeps,
  uri: string,
): Promise<{ hex: string; sizeBytes: number; readMs: number; hashMs: number } | null> {
  const file = deps.fs.file(uri);
  const hash = deps.hash();
  let sizeBytes = 0;
  let readMs = 0;
  let hashMs = 0;

  if (isContentUri(uri)) {
    const readStart = Date.now();
    const bytes = file.bytesSync();
    readMs = Date.now() - readStart;

    const hashStart = Date.now();
    hash.update(bytes);
    hashMs = Date.now() - hashStart;
    sizeBytes = bytes.byteLength;
  } else {
    const stream = streamFromFile(file);
    if (!stream) return null;
    const reader = stream.getReader();
    try {
      for (;;) {
        const readStart = Date.now();
        const { done, value } = await reader.read();
        readMs += Date.now() - readStart;
        if (done) break;
        if (value) {
          const hashStart = Date.now();
          hash.update(value);
          hashMs += Date.now() - hashStart;
          sizeBytes += value.byteLength;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  const digestStart = Date.now();
  const hex = hash.digestHex();
  hashMs += Date.now() - digestStart;

  return { hex, sizeBytes, readMs, hashMs };
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
