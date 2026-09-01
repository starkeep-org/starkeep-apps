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
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type { ExpoFileSystem } from "../storage/expo-object-storage";
import { isContentUri, streamFromFile } from "../storage/expo-object-storage";
import { listRecentMedia, type DeviceMediaItem, type DeviceMediaModule } from "./device-library";
import {
  advanceImportCursor,
  queryFloorFor,
  type ImportCursorStore,
} from "./import-cursor";
import type { MediaAliasStore } from "./media-alias";

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

  await writeDimensions(deps, record.id, type, item);
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

  const readStart = Date.now();
  const bytes = isContentUri(uri) ? file.bytesSync() : await collect(streamFromFile(file));
  const readMs = Date.now() - readStart;
  if (!bytes) return null;

  const hashStart = Date.now();
  const hex = await deps.hash(bytes);
  const hashMs = Date.now() - hashStart;

  return { hex, sizeBytes: bytes.byteLength, readMs, hashMs };
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

/**
 * Record the asset's pixel dimensions, which the media store already knows.
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
 * ## Width and height only
 *
 * Both categories declare `captured_at`, and the media store's creation time is
 * tempting for it. It is not written, because a metadata column must be
 * derivable from the record's *file bytes* and the store's creation time is a
 * fact about the store's own bookkeeping. `captured_at` belongs to whatever
 * eventually reads EXIF. `duration_ms` is a genuine fact about a video's bytes
 * and is left for the same pass, so that one commit owns "what the phone knows
 * about a record without decoding it".
 */
async function writeDimensions(
  deps: ImportDeps,
  recordId: StarkeepId,
  type: string,
  item: DeviceMediaItem,
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
  // The media store reports both or neither in practice, and a zero is how it
  // spells "not known" for an asset it failed to probe. Either way a partial
  // pair is worse than none: a width with no height still cannot be ordered,
  // and it would look like a known value to every reader.
  const { width, height } = item;
  if (typeof width !== "number" || typeof height !== "number") return;
  if (width <= 0 || height <= 0) return;

  await deps.database.putMetadata(category, { recordId, width, height });
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
