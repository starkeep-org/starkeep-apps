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
  typeCategory,
  type DataRecord,
  type HLCClock,
  type MetadataRow,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type { ExpoFileSystem } from "../storage/expo-object-storage";
import { isContentUri, streamFromFile } from "../storage/expo-object-storage";
import {
  listRecentMedia,
  type DeviceMediaItem,
  type DeviceMediaModule,
  type Timers,
} from "./device-library";
import {
  advanceImportCursor,
  queryFloorFor,
  type ImportCursorStore,
} from "./import-cursor";
import type { MediaAliasStore } from "./media-alias";
import { findMotionPhotoVideo } from "./motion-photo";
import { readImageExif } from "./exif";
import type { MotionIndexStore } from "./motion-index";

/**
 * SHA-256 over a whole buffer, supplied by the app's edge.
 *
 * ## Why one-shot rather than incremental
 *
 * It was incremental, on the reasonable assumption that streaming a large file
 * past a running hash beats materialising it. On this platform neither half of
 * that holds. A `content://` asset cannot be streamed at all (see
 * `streamFromFile`), so the bytes are already whole by the time anything can
 * hash them — and {@link MAX_INLINE_READ_BYTES} exists precisely because that
 * is unavoidable. Given the buffer is in hand either way, an incremental
 * interface only prevents the edge from handing over a *native* digest, which
 * is the entire performance story here.
 *
 * ## Measured on a real handset
 *
 * `js-sha256` on Hermes runs at **~1.4 MB/s**, dead consistent across ten
 * files. Pulling those same bytes across JSI runs at **~76 MB/s**. So hashing
 * was 98% of import — a 47 MB video cost 34 seconds to hash and half a second
 * to read. The read was never the problem, and the whole-file materialisation
 * this interface accepts is cheap next to what it enables.
 *
 * Declared here rather than imported so this module and its tests run in Node,
 * the same rule the storage adapter, the op-sqlite driver and the media module
 * all follow.
 */
export type HashBytes = (bytes: Uint8Array) => Promise<string>;

export interface ImportDeps {
  readonly media: DeviceMediaModule;
  readonly aliases: MediaAliasStore;
  readonly database: DatabaseAdapter;
  readonly clock: HLCClock;
  /** The same filesystem port everything else uses; content URIs go through it. */
  readonly fs: ExpoFileSystem;
  readonly hash: HashBytes;
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
   * Defaults to a real yield, which is a `setTimeout`.
   *
   * **A background window must pass {@link noYield} instead, and the reason is
   * not a preference.** React Native does not run JS timers in a headless
   * context: on a Pixel 5, in a process started for `SystemJobService`, timers
   * armed at five and twenty seconds had not fired three minutes later, while
   * native promises in the same context resolved in single-digit milliseconds.
   * A `setTimeout` there never fires at all, so `await yieldToUi()` becomes a
   * permanent hang on the first asset the loop actually wants to import — the
   * whole window lost, holding a claim on the process, with nothing reported.
   *
   * The yield exists to let the UI draw a frame between assets. A background
   * window has no UI to draw, so it gives up nothing by skipping it.
   */
  readonly yieldToUi?: () => Promise<void>;
  /**
   * Where this node stopped walking the media store last time.
   *
   * **Present for the background tick and absent for the foreground control**,
   * and the split is the point rather than an oversight. A watermark makes a
   * repeated scan cheap by asking the media store for nothing it has already
   * been asked about, which is exactly right for work that runs every fifteen
   * minutes forever and exactly wrong for a person tapping "Add photos" to
   * backfill a library that predates this node.
   *
   * Absent restores the original behaviour verbatim: the newest `limit` assets
   * by modification time, no floor, no watermark written.
   */
  readonly importCursor?: ImportCursorStore;
  /**
   * Where to record the video hiding inside a Motion Photo.
   *
   * Absent means "do not look", which is the right default for a node with no
   * such table — a laptop's fixtures, or the seeding pass. Present costs one XMP
   * scan over the first 512 KB of a buffer the loop is already holding, and no
   * extra read at all. See `motion-index.ts`.
   */
  readonly motionIndex?: MotionIndexStore;
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
  /**
   * Checked between assets. Set it to stop early.
   *
   * The same shape `SyncOptions.signal` takes, and for the same reason: a
   * background window is bounded by the OS, and a pass that runs past its
   * budget is killed rather than stopped — which loses the report of everything
   * it did manage. Stopping costs nothing, because `alreadyImported` makes the
   * next pass skip whatever this one finished.
   *
   * Checked *between* assets rather than inside one. A part-imported asset is
   * not a state this wants to be able to reach.
   */
  readonly signal?: { readonly aborted: boolean };
  /**
   * How long to wait for the media store before failing the pass.
   *
   * Supplied by the background tick and omitted by the foreground control. The
   * split matches the risk: a person watching a spinner can decide for
   * themselves how long to wait, and a headless window cannot — it is the one
   * that dies holding a claim on the process with nothing reported. See
   * {@link ListRecentOptions.timeoutMs}.
   */
  readonly queryTimeoutMs?: number;
  /**
   * The timer {@link queryTimeoutMs} runs on.
   *
   * Supplied by the background tick and omitted by the foreground control, and
   * the split is not a nicety: React Native drives `setTimeout` from a
   * `Choreographer` frame callback, and a headless process receives no frames,
   * so a deadline armed on the platform's timers in a background window never
   * fires at all. See `work/native-timers.ts`.
   */
  readonly timers?: Timers;
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
  /**
   * This pass only established the watermark, and imported nothing.
   *
   * Reported rather than left to look like an empty camera roll, because the
   * two are indistinguishable from the counts alone and mean opposite things:
   * one is a node that has just learned where "now" is and will import
   * everything from here, the other is a node with nothing to do.
   */
  readonly cursorSeeded?: boolean;
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
 * **64 MB, revised down from 256 MB.** The original number was chosen while the
 * suspected cost was reading, and it was picked to be generous. Measurement
 * moved the risk: reads run at ~76 MB/s, so 256 MB is over three seconds of
 * transfer *and* a quarter-gigabyte buffer in a JS heap that was already
 * reporting 127 MB of large objects at a fraction of that. A ceiling whose only
 * job is to prevent an OOM should not itself be an OOM.
 *
 * 64 MB covers every still including raw, and the clips a phone actually takes
 * — the largest in the test library was 47 MB. Longer video is excluded and
 * *reported* as such, which is the honest state until the native streaming read
 * (item 13b) removes the need to hold anything whole.
 */
export const MAX_INLINE_READ_BYTES = 64 * 1024 * 1024;

/**
 * The kinds of asset import will consider.
 *
 * Named rather than left to the media store's default, which is every file it
 * has indexed. `Query.exeForMetadata()` runs over `MediaStore.Files`, so without
 * this the window fills with whatever else is on the device — including other
 * applications' files under their own `Android/media/` directories, which this
 * app can neither type nor read. See {@link ListRecentOptions.mediaTypes}.
 *
 * Audio is excluded along with the rest. This is a photos app, and a record it
 * cannot show is a record it should not mint.
 */
export const IMPORTABLE_MEDIA_TYPES = ["image", "video"] as const;

/**
 * The yield for a caller with no user interface to yield to.
 *
 * A resolved promise rather than a timer, because React Native runs no JS
 * timers in a headless context — see {@link ImportDeps.yieldToUi}. Exported so
 * the background task names this decision rather than open-coding a bare
 * `Promise.resolve` whose significance nobody could read.
 */
export const noYield = (): Promise<void> => Promise.resolve();

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
  // **By modification time, not creation time**, and the difference is the
  // difference between importing a photograph and losing it. `creationTime` is
  // the media store's `DATE_TAKEN`, read from EXIF and null for any image that
  // carries none — and a null sort key behind a limit is not "last", it is
  // unreachable, because every pass asks the same question and gets the same
  // answer. `DATE_MODIFIED` is always set.
  //
  // It is also the better question for this caller. Import wants what has
  // recently *appeared or changed here*, which is not the same as what was
  // recently taken: a photograph copied from somebody else is new to this
  // device and years old in its own EXIF. And it lines up with the staleness
  // check below, which compares the very same field — so an asset edited in
  // place sorts back to the front exactly when {@link alreadyImported} has
  // decided it needs importing again.
  //
  // The watermark decides *which* window, and the three cases are different
  // enough to be worth naming. See `import-cursor.ts` for why the watermark
  // exists at all.
  const cursorStore = deps.importCursor;
  const cursor = cursorStore?.get() ?? null;

  // Before anything is imported, so every record this pass mints is at or after
  // the marker and is therefore covered by it. Set once and never moved: the
  // marker names when this node *started* looking, and advancing it would
  // silently reclassify records imported in between as scanned. See
  // `motion-index.ts`.
  if (deps.motionIndex && deps.motionIndex.scannedFrom() === null) {
    deps.motionIndex.markScannedFrom(now());
  }

  // A node that has never looked. Establishing the watermark is one row's worth
  // of media-store probe; importing the newest twenty is nine and a half
  // minutes' worth, and on a first background window that is a tick that gets
  // stopped and a process that gets frozen holding it.
  //
  // So the seeding pass imports nothing and says so. The camera roll that
  // predates this node is the foreground control's job — it takes sixty at a
  // time and shows a progress count — and it always was: a background window
  // that took the newest twenty and never looked further down was not
  // backfilling a library either.
  if (cursorStore && cursor === null) {
    const newest = await listRecentMedia(deps.media, {
      limit: 1,
      order: "modificationTime",
      mediaTypes: IMPORTABLE_MEDIA_TYPES,
      timeoutMs: options.queryTimeoutMs,
      timers: options.timers,
    });
    const seed = newest[0]?.modifiedAt ?? null;
    if (seed !== null) cursorStore.set(seed);
    return {
      scanned: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      failures: [],
      records: [],
      cursorSeeded: true,
    };
  }

  const items = await listRecentMedia(deps.media, {
    limit: options.limit,
    order: "modificationTime",
    modifiedSinceMs: queryFloorFor(cursor),
    mediaTypes: IMPORTABLE_MEDIA_TYPES,
    timeoutMs: options.queryTimeoutMs,
    timers: options.timers,
    // Oldest first when walking from a watermark, newest first without one.
    // A fixed window taken from the newest end cannot drain a backlog without
    // either skipping assets or re-offering them forever — see
    // `ListRecentOptions.ascending`.
    ascending: cursor !== null,
  });

  const records: DataRecord[] = [];
  const failures: ImportFailure[] = [];
  let imported = 0;
  let skipped = 0;

  const fail = (item: DeviceMediaItem, reason: string) =>
    failures.push({ assetId: item.id, filename: item.filename, reason });

  const yieldToUi = deps.yieldToUi ?? (() => new Promise<void>((r) => setTimeout(r, 0)));

  // Written after each asset rather than once at the end, because the process
  // running this loop is the one Android freezes and kills mid-call. A watermark
  // that only lands on a clean exit is a watermark that never lands on the
  // windows that matter, and the whole point of it is that the next window does
  // not repeat this one's media-store probe.
  //
  // Safe per-asset only because the walk is oldest-first: reaching asset `i`
  // means every asset below it is settled, so the watermark never steps over
  // something still outstanding.
  let watermark = cursor;
  const markDone = (item: DeviceMediaItem): void => {
    if (!cursorStore || item.modifiedAt === null) return;
    const next = advanceImportCursor(watermark, item.modifiedAt);
    if (next === watermark) return;
    watermark = next;
    cursorStore.set(next);
  };

  for (const [index, item] of items.entries()) {
    // Between assets, so a stopped pass leaves whole records behind rather than
    // a half-written one.
    if (options.signal?.aborted) break;
    try {
      if (await alreadyImported(deps, item)) {
        skipped += 1;
        markDone(item);
        continue;
      }
      // Between assets, not inside one: the JS thread is single, and holding it
      // for a whole batch is what made the button say "Adding…" and then freeze
      // — the frame that would have shown progress could never be drawn.
      await yieldToUi();

      const record = await importOne(deps, item, { originAppId, nowMs: now() });
      if ("reason" in record) {
        fail(item, record.reason);
        // **The watermark moves past a failure**, and the alternative was worse.
        // Holding it back means an asset this device can never read — a video
        // above `MAX_INLINE_READ_BYTES`, most obviously — pins the floor
        // forever, and every window from then on asks the media store for that
        // asset and everything newer than it. The result set grows without
        // bound and the query cost grows with it, which is precisely the
        // failure this watermark exists to prevent.
        //
        // What that gives up: a *transient* failure, such as an asset on a
        // volume that happened to be unmounted, is not retried by the
        // background loop. The failure is reported rather than swallowed, and
        // the foreground control runs without a watermark, so re-importing is
        // a tap rather than a lost photograph.
        markDone(item);
        continue;
      }
      records.push(record.record);
      imported += 1;
      markDone(item);
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
      // Past a throw for the same reason as past a returned failure above: an
      // asset that always throws would otherwise pin the watermark forever.
      markDone(item);
    }
  }

  return {
    // What the pass actually considered, which is not `items.length` once a
    // signal can stop it. A count of what was offered would make an interrupted
    // pass report the work it never reached.
    scanned: imported + skipped + failures.length,
    imported,
    skipped,
    failed: failures.length,
    failures,
    records,
  };
}

/**
 * How many assets one null-modification sweep considers.
 *
 * Ten, and small because the pass is cheap only if it stays at the head of the
 * ordering. Every row it asks for costs the media store's per-asset probe, and
 * unlike the import walk this pass has no watermark to shrink its result set —
 * it re-reads the same handful of rows on every run. Ten is enough to cover a
 * device with a few unreachable assets and small enough that repeating it costs
 * nothing worth measuring.
 */
export const NULL_MODIFIED_SWEEP_LIMIT = 10;

/**
 * Import the assets the watermark can never see.
 *
 * ## The blind spot
 *
 * `importDeviceMedia` filters the media store on `modificationTime >= floor`,
 * and a NULL satisfies no comparison. An asset the store recorded without a
 * `DATE_MODIFIED` is therefore skipped on every pass and will be skipped on
 * every future pass — not delayed, excluded. Waiting does not fix it and
 * neither does tapping the import button, which walks the same field.
 *
 * Screenshots are the observed producer; anything written by a restore or
 * side-loaded by another app can land the same way.
 *
 * ## Why this is ordered rather than filtered
 *
 * There is nothing to filter on. The `Query` API this app talks to exposes
 * `creationTime` and `modificationTime` and no other orderable field — no
 * `_id`, no `DATE_ADDED` — and `creationTime` is null for exactly the assets
 * that are missing `modificationTime`. So the pass uses the ordering itself:
 * the media store is SQLite, SQLite sorts NULLs **first** in an ascending scan,
 * and a query ordered `modificationTime` ascending with no floor therefore
 * returns the null-keyed rows at its head.
 *
 * That is also why it **stops at the first row that has a value**. Past the
 * null bucket lies the oldest end of the camera roll, and importing that is the
 * foreground button's job, not this pass's — a sweep that kept going would
 * quietly become a backfill of the entire library.
 *
 * ## Why it never moves the watermark
 *
 * A null-keyed asset has no position on the field the watermark measures.
 * Advancing it from one would be inventing a coordinate; `advanceImportCursor`
 * is not called here at all, and the ordinary import walk is left exactly where
 * it was.
 */
export async function importNullModified(
  deps: ImportDeps,
  options: ImportOptions,
): Promise<ImportOutcome> {
  const now = deps.now ?? Date.now;
  const originAppId = options.originAppId ?? "photos";

  const items = await listRecentMedia(deps.media, {
    limit: options.limit,
    order: "modificationTime",
    // Ascending and unfloored: the two together are what put the null-keyed
    // rows in reach. Either alone leaves them exactly as unreachable as the
    // import walk does.
    ascending: true,
    mediaTypes: IMPORTABLE_MEDIA_TYPES,
    ...(options.queryTimeoutMs !== undefined ? { timeoutMs: options.queryTimeoutMs } : {}),
    ...(options.timers ? { timers: options.timers } : {}),
  });

  const records: DataRecord[] = [];
  const failures: ImportFailure[] = [];
  let imported = 0;
  let skipped = 0;

  const yieldToUi = deps.yieldToUi ?? (() => new Promise<void>((r) => setTimeout(r, 0)));

  for (const item of items) {
    if (options.signal?.aborted) break;
    // The stop, and the whole reason this is a sweep rather than a backfill.
    if (item.modifiedAt !== null) break;
    try {
      if (await alreadyImported(deps, item)) {
        skipped += 1;
        continue;
      }
      await yieldToUi();
      const record = await importOne(deps, item, { originAppId, nowMs: now() });
      if ("reason" in record) {
        failures.push({ assetId: item.id, filename: item.filename, reason: record.reason });
        continue;
      }
      records.push(record.record);
      imported += 1;
    } catch (err) {
      failures.push({ assetId: item.id, filename: item.filename, reason: String(err) });
    }
  }

  return {
    scanned: imported + skipped + failures.length,
    imported,
    skipped,
    failed: failures.length,
    failures,
    records,
  };
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
 *
 * Condition 2 answers "already imported" for an asset whose mtime is null on
 * both sides, and that is the right answer rather than a hole. Such an asset —
 * the kind {@link importNullModified} exists for — is unverifiable by time in
 * exactly the sense `DeviceMediaItem.modifiedAt` describes: the store never
 * recorded when the bytes changed, so nothing can be compared. Treating it as
 * changed instead would re-import and re-hash it on every sweep forever, which
 * costs real work to learn nothing.
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

  await writeMediaMetadata(deps, record.id, type, item, digest.bytes);
  indexMotion(deps, objectStorageKey, type, item, digest.bytes);
  await deps.database.put(record);
  return { record, sizeBytes: digest.sizeBytes, readMs: digest.readMs, hashMs: digest.hashMs };
}

/**
 * Note where the video is inside a Motion Photo, if this JPEG is one.
 *
 * ## Why at import, and why here
 *
 * Android appends the video **inside the JPEG**, after the image data, and
 * describes where in XMP. There are no sibling files to pair, so nothing notices
 * unless something looks — and a Motion Photo imported without this is a still
 * that silently lost its motion, with the video sitting unreachable in bytes the
 * node already holds.
 *
 * The moment to look is this one because the whole file is in memory to be
 * hashed. The scan reads the first 512 KB of that buffer and costs no I/O.
 *
 * ## Only a JPEG, and only an image
 *
 * A video carries no such XMP, and neither does a HEIC or a PNG — the format is
 * Google's and it is defined over JPEG. Scanning the rest would be a text search
 * over megabytes that cannot match.
 *
 * ## Synchronous, and never fatal
 *
 * A write here must not be able to fail an import. The motion is a property of
 * bytes the record holds either way, so the worst case of losing this row is the
 * viewer's own fallback scan finding the same thing later.
 */
function indexMotion(
  deps: ImportDeps,
  objectStorageKey: string,
  type: string,
  item: DeviceMediaItem,
  bytes: Uint8Array,
): void {
  if (!deps.motionIndex) return;
  if (typeCategory(type) !== "image") return;
  if (!isJpeg(type, item.filename)) return;
  try {
    const found = findMotionPhotoVideo(bytes);
    // Only when there is something to say. A negative row per still would be a
    // row per image record — sixty thousand of them saying nothing — and the
    // marker set at the top of the pass is what makes their absence an answer.
    // See `motion-index.ts`.
    if (found) deps.motionIndex.record(objectStorageKey, found);
  } catch {
    // Malformed XMP is a camera's mistake and not this import's. The record and
    // its bytes are unaffected.
  }
}

/** Whether these are JPEG bytes, by the type the extension produced. */
function isJpeg(type: string, filename: string | null): boolean {
  if (type === "image/jpeg") return true;
  // A filename the extension map did not recognise still lands in `image` only
  // by way of `defaultTypeForExtension`, so this is belt and braces for the
  // spellings that map to the same encoder.
  return /\.jpe?g$/i.test(filename ?? "");
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
): Promise<{
  hex: string;
  sizeBytes: number;
  readMs: number;
  hashMs: number;
  /**
   * The bytes that were hashed, so a caller can ask a second question of them.
   *
   * Returned rather than discarded because the alternative is a second whole
   * read. A `content://` asset cannot be ranged, so anything that wants to look
   * inside one pays for the entire file — and the Motion Photo scan wants the
   * first 512 KB of exactly the buffer that is already in hand. Holding it a few
   * lines longer costs nothing; reading it twice costs everything.
   */
  bytes: Uint8Array;
} | null> {
  const file = deps.fs.file(uri);

  const readStart = Date.now();
  const bytes = isContentUri(uri) ? file.bytesSync() : await collect(streamFromFile(file));
  const readMs = Date.now() - readStart;
  if (!bytes) return null;

  const hashStart = Date.now();
  const hex = await deps.hash(bytes);
  const hashMs = Date.now() - hashStart;

  return { hex, sizeBytes: bytes.byteLength, readMs, hashMs, bytes };
}

/** A stream, whole. Bounded by {@link MAX_INLINE_READ_BYTES} at the call site. */
async function collect(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  if (!stream) return null;
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** What one duration-backfill pass looked at, and what it repaired. */
export interface BackfillOutcome {
  /** Media-store rows this pass paid for. */
  readonly scanned: number;
  /** Durations recorded against a record that had none. */
  readonly written: number;
  /**
   * Every video on this device has now been looked at.
   *
   * The signal to stop calling this. A pass that returns fewer rows than it
   * asked for has reached the end of the roll, and there is nothing further
   * back to repair.
   */
  readonly complete: boolean;
}

/** What the backfill needs, which is a strict subset of what import needs. */
export interface BackfillDeps {
  readonly media: DeviceMediaModule;
  readonly aliases: MediaAliasStore;
  readonly database: DatabaseAdapter;
  /** Its own watermark — see {@link VIDEO_DURATION_CURSOR_TABLE}. */
  readonly cursor: ImportCursorStore;
}

/**
 * Fill in the length of clips imported before the record carried one.
 *
 * ## Why a backfill is needed at all
 *
 * `writeMediaMetadata` records a duration from the row import already reads, so
 * every clip imported from now on has one. Every clip imported *before* it does
 * not, and re-importing will not fix them: `alreadyImported` skips an asset
 * whose media-store mtime is unchanged, which is precisely the case here. The
 * bytes did not change; only what this node bothered to write about them did.
 *
 * ## Why it walks a watermark rather than asking about the records it wants
 *
 * The obvious pass is "find the records with no duration, then ask the media
 * store about exactly those assets". **The media store cannot be asked that
 * question.** `Query` filters on the fields `AssetField` names — creation and
 * modification time, media type, width, height, duration, favourite — and an
 * asset's id is not among them. There is no `id IN (…)`.
 *
 * What is available is the same filter import uses, and it is enough: walking
 * `modificationTime` forward from a watermark, filtered to video, returns only
 * rows this pass has not already considered. That matters more here than
 * anywhere else in the app, because a returned row is the expensive thing —
 * `exeForMetadata()` runs `MediaMetadataRetriever` per row inside the media
 * store process — and a pass that re-offered finished clips would pay full
 * price for work already done. See `import-cursor.ts`.
 *
 * Forward from the oldest, rather than back from the newest, because that is
 * the direction a watermark can advance monotonically. The newest clips are the
 * ones import has been recording durations for all along.
 *
 * ## What `limit` has to be bigger than
 *
 * The number of clips a camera can write inside one second. The next query
 * floors at the watermark minus a second — see `CURSOR_OVERLAP_MS`, which
 * exists because `DATE_MODIFIED` has whole-second granularity — so a batch
 * filled entirely by clips sharing the boundary second returns the same rows on
 * every pass and the walk stops advancing. Twenty-five is the caller's number
 * and no camera writes twenty-five clips in a second.
 *
 * ## What it deliberately cannot repair
 *
 * A clip whose bytes arrived by sync has no alias and no asset on this device,
 * so no media-store row will ever describe it. Those keep a null duration and
 * render as the word "video", which `formatDuration` already handles and which
 * is the true thing to say — nothing on this device knows how long they are.
 *
 * A repaired duration also stays on this device until something touches the
 * record. Metadata rides a record when a round is cut, and these records were
 * shipped long ago, so the row written here reaches no peer. That is the right
 * trade rather than a gap worth closing: the duration exists for this device's
 * own grid, and a node that derives reads the length out of the file.
 */
export async function backfillVideoDurations(
  deps: BackfillDeps,
  options: {
    readonly limit: number;
    readonly queryTimeoutMs?: number;
    readonly timers?: Timers;
  },
): Promise<BackfillOutcome> {
  const cursor = deps.cursor.get();
  const items = await listRecentMedia(deps.media, {
    limit: options.limit,
    order: "modificationTime",
    modifiedSinceMs: queryFloorFor(cursor),
    // Video only. Every other row would be paid for and discarded, and the
    // per-row probe is the entire cost of this pass.
    mediaTypes: ["video"],
    ascending: true,
    timeoutMs: options.queryTimeoutMs,
    timers: options.timers,
  });

  // Alias, then record, then the metadata row — three local lookups, gathered
  // before anything is written so the metadata read is one query for the batch
  // rather than one per clip.
  const candidates: Array<{ recordId: StarkeepId; durationMs: number }> = [];
  for (const item of items) {
    if (typeof item.durationMs !== "number" || item.durationMs <= 0) continue;
    const alias = deps.aliases.byAssetId(item.id);
    if (!alias) continue;
    const record = await deps.database.get(alias.recordId);
    // The record's own type decides the table, not the media store's category.
    // An asset the store calls video whose extension made an image record would
    // otherwise put a row in a table no reader of that record looks in.
    if (!record || typeCategory(record.type) !== "video") continue;
    candidates.push({ recordId: record.id, durationMs: item.durationMs });
  }

  let written = 0;
  if (candidates.length > 0) {
    const existing = await deps.database.getMetadataByIds(
      "video",
      candidates.map((c) => c.recordId),
    );
    for (const candidate of candidates) {
      // Already answered, by import or by a previous pass over the one-second
      // overlap this walk re-offers on every boundary.
      if (typeof existing.get(candidate.recordId)?.["duration_ms"] === "number") continue;
      await deps.database.putMetadata("video", {
        recordId: candidate.recordId,
        duration_ms: candidate.durationMs,
      });
      written += 1;
    }
  }

  // After the writes rather than per item, and the difference from the import
  // loop is deliberate: this pass writes one small row per clip and cannot be
  // left half-done in a way that matters, so repeating a whole batch after a
  // kill costs one query and repairs the same rows to the same values.
  let watermark = cursor;
  for (const item of items) {
    if (item.modifiedAt === null) continue;
    watermark = advanceImportCursor(watermark, item.modifiedAt);
  }
  if (watermark !== null && watermark !== cursor) deps.cursor.set(watermark);

  return { scanned: items.length, written, complete: items.length < options.limit };
}

/**
 * How many aliased stills one EXIF-backfill pass reads.
 *
 * The pass reads whole photographs, because the facts it wants live in the
 * file's header and a `content://` asset cannot be streamed — see `hashFile`.
 * On this handset a photograph is about a megabyte, so twenty-four of them is
 * roughly a third of a second of transfer, which is a batch a screen can absorb
 * between yields.
 */
export const IMAGE_EXIF_BACKFILL_LIMIT = 24;

/** What the EXIF backfill needs: the node's own tables, plus the filesystem. */
export interface ImageExifBackfillDeps {
  readonly aliases: MediaAliasStore;
  readonly database: DatabaseAdapter;
  readonly fs: ExpoFileSystem;
}

/** Where an EXIF backfill pass stopped, so the next one resumes. */
export interface ImageExifBackfillOutcome extends BackfillOutcome {
  /**
   * The alias key to resume after, or null once the walk is done.
   *
   * Carried in the outcome rather than persisted, because the whole walk fits
   * in one app open — see {@link backfillImageExif} on why the set is bounded
   * by what this node imported rather than by what the device holds.
   */
  readonly resumeAfter: string | null;
}

/**
 * Fill in the capture time and orientation of stills imported before the record
 * carried them.
 *
 * ## Why this walks the node and not the media store
 *
 * Its first version walked `modificationTime` forward from a watermark, copying
 * `backfillVideoDurations`. **That cannot work here, and the reason is a
 * hundredfold difference in scale.** The duration pass walks the store because a
 * duration is a fact only the store holds; it gets away with it because the
 * store held 51 videos. EXIF is a fact about the *file*, the alias table already
 * names the file, and the store held **4,806 images of which this node had
 * imported 96** — the newest 96, at the far end of an ascending walk. Measured
 * on the handset after a full app open, the watermark had crawled to November
 * 2018 and written nothing, and it would have needed some six hundred batches
 * to reach a single record it could repair.
 *
 * Walking the alias table instead visits exactly the records that can be
 * repaired, in a set bounded by what this node imported rather than by what the
 * camera roll happens to contain. It also needs no media-store query at all, so
 * the pass costs no per-row `ExifInterface` probe — the expense that shapes
 * every other walk in this file.
 *
 * ## Why the position is not persisted
 *
 * Because the walk finishes. The set is the node's own imports, the caller runs
 * batches back to back until this reports completion, and a run that is cut
 * short by the app closing simply starts again — re-reading a header is cheap
 * and writes the same values. A watermark would be a second, weaker way to
 * express a position the caller already holds for as long as it matters.
 *
 * ## What it deliberately cannot repair
 *
 * A still whose bytes arrived by sync has no alias and no file on this device.
 * It keeps whatever capture time the node that imported it wrote, which is the
 * right answer: that node read the same header.
 *
 * A photograph carrying no `DateTimeOriginal` — a screenshot, or an image a
 * messaging app stripped — is read and left with nothing, so it stays in the
 * grid's null bucket ordered by import time. That is the only thing anything
 * knows about when it was made.
 *
 * **Those files are re-read on every walk**, because nothing records that they
 * were already asked. On the handset this was written for that is 27 files of
 * about a megabyte each, so roughly a third of a second per app open, against
 * 53 that the first walk repairs permanently. The fix would be a column or a
 * table saying "looked, found nothing", and it is not worth one yet — but it is
 * the thing to add if the untagged share of a library ever grows.
 */
export async function backfillImageExif(
  deps: ImageExifBackfillDeps,
  options: { readonly limit: number; readonly after?: string | null },
): Promise<ImageExifBackfillOutcome> {
  const page = deps.aliases.listAfter(options.after ?? null, options.limit);
  if (page.length === 0) {
    return { scanned: 0, written: 0, complete: true, resumeAfter: null };
  }

  // The records themselves, so the pass knows which aliases name a still. An
  // alias table holds videos too, and `getMetadataByIds("image", …)` cannot tell
  // a video's alias apart from a photograph whose metadata row was never
  // written — both are simply absent from its answer.
  const ids = page.map((alias) => alias.recordId as StarkeepId);
  const found = await deps.database.query({
    filters: [{ field: "id", operator: "in", value: ids }],
    limit: ids.length,
  });
  const stills = new Set(
    found.records.filter((record) => typeCategory(record.type) === "image").map((r) => r.id),
  );

  // One metadata read for the batch, before any file is opened, so the
  // expensive step runs only for records that actually need it.
  const existing = await deps.database.getMetadataByIds("image", [...stills]);

  let written = 0;
  let scanned = 0;
  for (const alias of page) {
    const recordId = alias.recordId as StarkeepId;
    if (!stills.has(recordId)) continue;
    const row = existing.get(recordId);
    // **`== null`, not `!== undefined`, and the difference is the whole bug this
    // replaced.** A record with no capture time has that column as SQL `NULL`,
    // which `SqliteDatabaseAdapter` returns as `null` on a row it selected with
    // `SELECT *`. `MockDatabaseAdapter` stores only the columns somebody wrote,
    // so the same absence reads as `undefined` there. Testing for `undefined`
    // alone therefore passed every test and skipped every record on the
    // handset: five batches, ninety-seven aliases, nothing scanned.
    const hasCaptured = row?.["captured_at"] != null;
    const hasOrientation = row?.["orientation"] != null;
    if (hasCaptured && hasOrientation) continue;

    scanned += 1;
    const bytes = deps.fs.file(alias.contentUri).bytesSync();
    if (!bytes) continue;
    const exif = readImageExif(bytes);

    const update: MetadataRow = { recordId };
    if (exif.capturedAt && !hasCaptured) {
      update["captured_at"] = exif.capturedAt;
    }
    if (exif.orientation !== null && !hasOrientation) {
      update["orientation"] = exif.orientation;
    }
    // A header that said nothing. Writing a row holding only the key would make
    // every reader treat it as present-but-empty — the same argument
    // `writeMediaMetadata` makes about its own row.
    if (Object.keys(update).length === 1) continue;
    await deps.database.putMetadata("image", update);
    written += 1;
  }

  const complete = page.length < options.limit;
  return {
    scanned,
    written,
    complete,
    resumeAfter: complete ? null : page[page.length - 1]!.objectStorageKey,
  };
}

/**
 * Record what the media store already knows about the asset without decoding it.
 *
 * ## Why this is not optional
 *
 * Variant resolution orders a record's renditions by long edge, so a candidate
 * with no dimensions is unorderable and gets dropped. A *parent* with no
 * dimensions is worse: there is no applicable set to compute, so
 * `resolveLibraryRenditions` falls back to `resolveWithoutDimensions` and can
 * only choose among renditions that happen to exist rather than name the rung
 * a tile should have. The cloud reaches the same dead end and reports the
 * original as having no renditions at all, which it cannot tell apart from
 * "nothing derived yet" — the exact confusion that made Photos re-derive a
 * complete ladder on every load before `1bcc03a`.
 *
 * The phone was the one importer writing no dimensions at all, and it is the
 * importer with the least excuse: `expo-media-library` returns width and height
 * on the same query row the import loop already reads, so this costs one write
 * and no decode.
 *
 * ## Before the record, not after
 *
 * `1bcc03a` made metadata ride the record over the wire, read once per shipment
 * after a round is cut. A row written *after* `put` is therefore invisible to
 * any round that cuts in between, and only a later write to the record would
 * offer it again. Writing first means the record's own clock — set by `put` on
 * the next line — already covers the dimensions, and no window exists to lose
 * them in.
 *
 * The interrupted state is a metadata row whose record was never written. It is
 * self-repairing rather than merely harmless: a record id is content-addressed
 * from `(parent, filename, hash)`, so a retry of the same asset mints the same
 * id and overwrites the same row.
 *
 * ## Dimensions, duration, and what the header says
 *
 * Both categories declare `captured_at`, and the media store's creation time is
 * tempting for it. It is still not written from there, and the rule is the one
 * this comment has always stated: a metadata column must be derivable from the
 * record's *file bytes*, and `DATE_TAKEN` is a fact about the store's own
 * bookkeeping. What changed is that the bytes are now read — `hashFile` already
 * holds the whole file to hash it, and `indexMotion` on the next line already
 * asks that same buffer a second question, so asking it a third costs a header
 * parse and no I/O at all. See `media/exif.ts`.
 *
 * That gives `captured_at`, which is what the library grid orders by, and
 * `orientation`, which is what tells a consumer whether the `width` and
 * `height` below swap when displayed.
 *
 * ## The dimensions are the stored ones, and the orientation is why that is safe
 *
 * `AssetField.WIDTH` maps to `MediaStore.MediaColumns.WIDTH` with no rotation
 * correction — unlike `expo-media-library`'s legacy `Asset` API, which calls
 * `maybeRotateAssetSize`. So these numbers describe the bytes, not the picture.
 * That is the right thing to record, and it was wrong only because nothing was
 * recorded beside it: a consumer laying a photograph out from record metadata
 * got a landscape box for a portrait photograph, which is what
 * `justified-layout.ts` and `render-geometry.ts` in the web app do.
 *
 * The header's own `PixelXDimension` wins when present, because it cannot
 * disagree with the orientation written next to it.
 *
 * `duration_ms` is written, because it is a genuine fact about a video's bytes
 * and the media store reports it on the row this loop already reads. Without it
 * no record can answer how long a clip runs, and a library tile has to say
 * "video" where the device grid says "0:42".
 */
async function writeMediaMetadata(
  deps: ImportDeps,
  recordId: StarkeepId,
  type: string,
  item: DeviceMediaItem,
  bytes: Uint8Array,
): Promise<void> {
  // The category, not the type. `SqliteDatabaseAdapter` happens to normalize a
  // `<category>/<format>` id to its table, but `MockDatabaseAdapter` keys on
  // the argument verbatim — so passing `image/jpeg` here would store a row that
  // `getMetadataByIds("image", …)` never finds. Naming the category is what
  // both adapters agree on, and it is what every reader already asks for.
  const category = typeCategory(type);
  // `other` has no metadata table — see `sqliteMetadataTableName`. Anything the
  // extension did not identify lands there, and writing would target a table
  // that is deliberately never created.
  if (category === "other") return;

  const row: MetadataRow = { recordId };

  // The media store reports both or neither in practice, and a zero is how it
  // spells "not known" for an asset it failed to probe. Either way a partial
  // pair is worse than none: a width with no height still cannot be ordered,
  // and it would look like a known value to every reader.
  // Read once, for the two columns below plus the dimensions it may override.
  // Only for stills: `readImageExif` walks a JPEG's segment chain and answers
  // nulls for anything else, and running it over a video's bytes is a scan that
  // can only fail.
  const exif = category === "image" ? readImageExif(bytes) : null;

  // The header's dimensions when it has them, the media store's otherwise. The
  // pair is still all-or-nothing: a width with no height cannot be ordered and
  // would look like a known value to every reader.
  const width = exif?.width ?? item.width;
  const height = exif?.height ?? item.height;
  if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
    row["width"] = width;
    row["height"] = height;
  }

  // The two the header is actually read for. Both are absent far more often
  // than not — a screenshot carries neither — and absent is a state every
  // reader already handles, so neither is defaulted.
  if (exif?.capturedAt) row["captured_at"] = exif.capturedAt;
  if (exif?.orientation !== null && exif?.orientation !== undefined) {
    row["orientation"] = exif.orientation;
  }

  // Guarded the same way the pair above is, and for the same reason: a zero or
  // a negative is the store spelling "not known", and written as a value it
  // would make a tile claim a zero-length clip — which describes a broken file
  // rather than an unmeasured one. `formatDuration` renders the absence as the
  // word "video", which is the true thing to say.
  //
  // Only for the video category. `image` and `audio` declare no `duration_ms`
  // and an `audio` clip is never imported (see IMPORTABLE_MEDIA_TYPES).
  if (category === "video" && typeof item.durationMs === "number" && item.durationMs > 0) {
    row["duration_ms"] = item.durationMs;
  }

  // Nothing but the key means the store measured nothing, and a row holding one
  // column is a row every reader has to treat as present-but-empty.
  if (Object.keys(row).length === 1) return;
  await deps.database.putMetadata(category, row);
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
