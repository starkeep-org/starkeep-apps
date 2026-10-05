/**
 * Assembling the phone as a sync peer (item 12).
 *
 * ## What this is, and what it deliberately is not
 *
 * This wires the existing engine to the phone's adapters and nothing more.
 * There is no phone-specific sync logic here, and there should never be: the
 * exchange, the watermarks, the residency decision and the transfer rules are
 * the same on every node, and a second implementation "for mobile" is how two
 * nodes come to disagree about what they have.
 *
 * The phone differs in three ways, all of them *configuration*:
 *
 * 1. **It is not the cloud node.** `starkeep/no-cloud` forbids the cloud and
 *    says nothing about a handset, so `isCloudNode` is false and such records
 *    are held freely — reading the constraint as "nobody may hold this" would
 *    turn a privacy preference into data loss.
 * 2. **Its ceiling is lower.** The platform's phone row receives image
 *    stand-ins up to 1280 pixels and no video or audio stand-ins, so a phone
 *    with 8 GB against a 60k-item library holds the library it can show and
 *    fetches the rest when asked.
 * 3. **Its rounds are smaller.** See {@link MOBILE_MAX_BYTES}.
 */

import { createHLCClock } from "@starkeep/protocol-primitives";
import { SqliteDatabaseAdapter, type SqliteDriver } from "@starkeep/storage-sqlite";
import {
  createLibrarySettings,
  createSyncEngine,
  createSqliteSyncStateStore,
  createResidencyManager,
  residencyHooks,
  runAcquisition,
  scanForAcquirable,
  type AcquisitionOutcome,
  type BlobCandidate,
  type LibrarySettings,
  type ReplicaProbe,
  type ResidencyManager,
  type FreeUpSpaceReport,
  type SyncEngine,
  type SyncOptions,
  type SyncResult,
  type VerifyResult,
  type SyncTransport,
} from "@starkeep/sync-engine";
import type { DataRecord, SyncDownCeilings } from "@starkeep/protocol-primitives";
import { DEFAULT_SYNC_DOWN_CEILINGS } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createSqliteMediaAliasStore, type MediaAliasStore } from "./media/media-alias";
import { createSqliteMotionIndexStore, type MotionIndexStore } from "./media/motion-index";
import {
  createSqliteScanCursorStore,
  DERIVATION_CURSOR_TABLE,
  FULL_DERIVATION_CURSOR_TABLE,
  type ScanCursorStore,
} from "./work/scan-cursor";
import {
  createSqliteImportCursorStore,
  VIDEO_DURATION_CURSOR_TABLE,
  type ImportCursorStore,
} from "./media/import-cursor";
import { DeviceMediaObjectStorage } from "./storage/device-media-storage";
import { createDeviceSettingsStore, type DeviceSettings } from "./device-settings";
import type { ExpoFileSystem } from "./storage/expo-object-storage";

/**
 * Byte budget for one exchange round on a phone.
 *
 * The budget that actually binds here, because a round on this channel is
 * photos: at ~3 MB each this is three or four of them, roughly fifteen seconds
 * on a mobile uplink. Constraint 2 of the phase — no work item may assume more
 * than a few seconds — is not a suggestion on a handset, because the OS decides
 * when the app stops, and a round that takes a minute is a round that gets
 * abandoned partway over and over, making progress impossible rather than
 * merely slow.
 *
 * Counting items instead would be the wrong unit: six photos is 18 MB and six
 * captions is nothing. Smaller rounds mean more round trips, which is the right
 * trade when the alternative is a round trip that never completes — and the
 * watermark makes an abandoned round free to retry, so the only cost of being
 * wrong in this direction is bandwidth.
 *
 * One item larger than this still ships alone; see `SyncEngineOptions.maxBytes`.
 * That is what keeps a 400 MB video from stalling the channel forever.
 */
export const MOBILE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Item cap for one round, which binds only on rows carrying no blobs.
 *
 * Well above what {@link MOBILE_MAX_BYTES} implies for photos, deliberately:
 * two hundred labels is a small request, and splitting it across rounds would
 * be pure round-trip overhead for no durability gain.
 */
export const MOBILE_MAX_ITEMS = 200;

/**
 * Concurrent blob transfers per round. Below the engine's default of 4 because
 * every in-flight transfer costs memory and a handset has little to spare.
 */
export const MOBILE_TRANSFER_CONCURRENCY = 3;

/**
 * Records the catalogue scan looks at in one unit of work.
 *
 * Sized by the same constraint as everything else here — a few seconds — and
 * generous, because a unit is a keyed resident-set lookup and a label read per
 * record, with no network and no storage probe. A 60k-item library is a few
 * dozen of these, spread over whatever windows the OS grants.
 */
export const MOBILE_SCAN_RECORDS = 2000;

export interface MobileNodeOptions {
  readonly nodeId: string;
  /** Where op-sqlite should put the database. */
  readonly databasePath: string;
  readonly sqliteDriver: SqliteDriver;
  readonly localObjectStorage: ObjectStorageAdapter;
  /**
   * The cloud, reached over whatever transport the shell supplies.
   *
   * **Optional, and its absence is a supported way to run** — not a degraded
   * one. A handset with no session holds its own photos, imports them, indexes
   * them and answers every question about them; what it cannot do is exchange
   * with anyone. Requiring a transport here said the opposite: that no node
   * exists until there is a cloud to talk to, which is the sign-in gate the
   * rest of this app spent two revisions removing, re-appearing as a type.
   *
   * Supplied together or not at all: a transport with no remote object storage
   * could ship metadata and then fail every blob transfer, which is a worse
   * state than being offline because it looks like it is working.
   */
  readonly cloud?: {
    readonly transport: SyncTransport;
    readonly remoteObjectStorage: ObjectStorageAdapter;
  };
  /**
   * This device's sync-down ceilings — the largest stand-in per category it
   * receives without being asked. The platform's phone row unless the person
   * changed it: 1280-pixel images, and no video stand-ins.
   */
  readonly ceilings?: SyncDownCeilings;
  readonly wallClock?: () => number;
  /**
   * Let this node's object storage read the device's own camera roll.
   *
   * Supplying this turns on aliasing: import records a photo without copying
   * its bytes, and the blob for such a record resolves to the MediaStore asset
   * that already holds them (`import-loop-design.md` §2). Absent — on a laptop,
   * or in a test that does not care — the node behaves exactly as before.
   *
   * The wrapping happens *here* rather than at the app's edge because the alias
   * table lives in this node's database, which does not exist until this
   * function creates it. Handing the caller a half-built object storage to
   * finish assembling later would put the one invariant that matters — that the
   * engine and the importer see the *same* view of what this node holds — in
   * the caller's hands.
   */
  readonly deviceMedia?: { readonly fs: ExpoFileSystem };
}

export interface MobileNode {
  readonly databaseAdapter: DatabaseAdapter;
  /**
   * How far background import has walked the camera roll, or null when this
   * node does not read one.
   *
   * Lives here for the same reason {@link MobileNode.mediaAliases} does: the
   * table is in this node's database, which does not exist until
   * `createMobileNode` builds it. Exposed rather than held privately because the
   * two callers want opposite things from it — the background tick supplies it
   * so a repeated scan stays cheap, and the foreground "Add photos" control
   * deliberately runs without it so a person can backfill a library that
   * predates this node. See `media/import-cursor.ts`.
   */
  readonly importCursor: ImportCursorStore | null;
  /**
   * How far the duration backfill has walked the camera roll's videos, or null
   * when this node does not read one.
   *
   * A second watermark rather than a reuse of {@link MobileNode.importCursor},
   * because the two walk the same field for opposite reasons: import walks
   * forward from "now" to notice what is new, and the backfill walks forward
   * from the beginning of the roll to repair clips imported before a record
   * carried a duration. See `backfillVideoDurations`.
   */
  readonly videoDurationCursor: ImportCursorStore | null;
  /**
   * How far the derivation sweep has walked this device's own originals, or
   * null when this node reads no camera roll.
   *
   * Persisted rather than held in a window, and that is the whole reason it
   * exists: a background window derives a handful of records, and a sweep that
   * restarted at the beginning of the alias table each time would re-read the
   * same pages forever and never reach the records at the far end. The
   * acquisition scan's cursor makes the same argument about the same problem;
   * this is a second table of the same shape. See `work/scan-cursor.ts`.
   */
  readonly derivationCursor: ScanCursorStore | null;
  /**
   * How far the full-ladder sweep — 2560 and the canonical — has walked this
   * device's originals, or null when this node reads no camera roll. Its own
   * table, because it walks the same aliases at a different pace, and one
   * cursor would make each sweep skip what the other reached.
   */
  readonly fullDerivationCursor: ScanCursorStore | null;
  /** This device's photo ceiling and derivation switch, as stored. */
  deviceSettings(): DeviceSettings;
  /**
   * Change this device's photo sync-down ceiling. Takes effect at once and
   * removes nothing: a raised ceiling reaches earlier-declined stand-ins
   * through the next catalogue scan, which restarts from the top.
   */
  setImageCeiling(ceiling: number | null): DeviceSettings;
  /** Turn this device's background photo derivation on or off. */
  setDerivePhotoStandIns(on: boolean): DeviceSettings;
  /**
   * Where the video inside a Motion Photo is, or null when this node reads no
   * camera roll.
   *
   * Exposed for the same reason the alias table is: the import loop writes it
   * and the viewer reads it, and the table lives in this node's database, which
   * does not exist until `createMobileNode` builds it.
   *
   * Deliberately invisible to the sync engine. The row describes a byte range
   * inside a blob the engine already moves whole, and teaching the engine that a
   * record has an inside would be the first crack in the seam that keeps mobile
   * a configuration of the node rather than a fork of it.
   */
  readonly motionIndex: MotionIndexStore | null;
  /**
   * What this node holds — including, when `deviceMedia` was supplied, the
   * camera-roll assets it has aliased rather than copied.
   */
  readonly objectStorage: ObjectStorageAdapter;
  /**
   * The alias table, or null when this node does not read a camera roll.
   *
   * Exposed because the import loop writes to it and the residency inspector
   * reads it. It is deliberately *not* something the sync engine can see: an
   * aliased blob is `resident` through `localStorage.has()` like any other, and
   * teaching the engine otherwise would be the first crack in the seam that
   * keeps mobile a configuration of the node rather than a fork of it.
   */
  readonly mediaAliases: MediaAliasStore | null;
  /**
   * Null when no cloud was supplied, which is the ordinary state of a handset
   * nobody has signed in on. Everything else on this node works regardless.
   */
  readonly engine: SyncEngine | null;
  /**
   * The library's settings, as the settings file this node received says. The
   * phone never edits the file: it stamps originals with its values, and reads
   * each original's target from the original's stamp.
   */
  readonly librarySettings: LibrarySettings;
  /** This node's residency: its ceilings and what it holds. */
  readonly residency: ResidencyManager;
  /**
   * Run one exchange round. Safe to abandon; the watermark makes it resumable.
   *
   * Returns null on a node with no cloud rather than throwing. A caller
   * scheduling background work should not have to know whether this device has
   * ever been signed in, and the alternative — an exception on the ordinary
   * offline path — is how a job queue learns to swallow exceptions.
   *
   * Serialized against {@link sync} and {@link verify}: all three read, modify
   * and write the same sync state, and two at once let the later write clobber
   * a repair floor the earlier one was relying on. A second caller waits rather
   * than racing.
   */
  exchange(): Promise<unknown>;
  /**
   * Sync until both directions are drained, pulling before pushing.
   *
   * What a user means by "sync now". A single round moves at most one round's
   * budget, so a first upload of a real library needs hundreds of them — one
   * per tap is not a sync, it is a progress bar with a manual crank.
   *
   * Same null-on-no-cloud contract as {@link exchange}, and equally safe to
   * abandon: each round persists its own watermarks, so backgrounding the app
   * mid-loop costs at most the round in flight.
   */
  sync(options?: SyncOptions): Promise<SyncResult | null>;
  /**
   * Work through the acquisition queue: fetch files this device wants and
   * lacks — stand-ins a raised ceiling now covers, bytes that went missing — until the tick's byte cap runs out.
   *
   * Serialized with {@link sync} for the same reason everything else here is —
   * one engine, one operation at a time.
   */
  acquireQueued(options?: { readonly maxBytes?: number }): Promise<AcquisitionOutcome | null>;
  /**
   * Walk a page of the catalogue looking for records this device wants bytes
   * for and has none of, and queue them.
   *
   * A round decides each file once, as the change log offers it. The scan finds
   * what this device wants and lacks now, whatever the round decided then.
   *
   * Bounded and resumable: it takes a page, remembers where it stopped, and
   * carries on from there next time. `complete` is how a caller tells "this
   * device now knows everything it is missing" from "it knows about the first
   * few thousand".
   */
  scanForAcquirable(options?: {
    readonly maxRecords?: number;
  }): Promise<{ readonly queued: number; readonly complete: boolean }>;
  /**
   * Compare row counts with the cloud and arm a repair for anything it lacks.
   *
   * Answers the question a watermark cannot: a coverage watermark is a
   * timestamp per author, so it can say "caught up" while the cloud is missing
   * a row from the middle of a range — and it can never say *how many* rows are
   * safely off this device, which is the thing a person actually wants to know
   * about a backup.
   *
   * Occasional, not per-sync: a grouped scan on both sides.
   */
  verify(): Promise<VerifyResult | null>;
  /**
   * Fetch the bytes of a record this node holds a row for but not a blob.
   *
   * The reversal half of eliding. An elided record advances the watermark —
   * that is what makes declining a blob a terminal state instead of a
   * permanent retry — so the cloud will never offer those bytes again and no
   * amount of syncing brings them back. This is the only route.
   *
   * Resolves false when there is no cloud to fetch from, when the record has no
   * blob, or when the transfer failed. It does *not* resolve false for a key a
   * sync round is already moving: that call joins the round's transfer and
   * reports its outcome, because "wait a moment" and "it failed" are different
   * answers and the placeholder should only stay for one of them.
   */
  fetchBlob(record: DataRecord): Promise<boolean>;
  /**
   * Record bytes this node produced itself — a stand-in the derivation pass
   * encoded — so the Storage section counts them at once rather than after the
   * next catalogue scan adopts them.
   */
  noteDerived(record: DataRecord): Promise<void>;
  /**
   * The person's "Free up space": remove originals — and, in the wider scope,
   * stand-ins above this device's ceiling — largest first, each only after the
   * cloud is proved to hold it, its original and the original's canonical
   * stand-in. The one path that removes a file from this device; nothing calls
   * it on a timer.
   *
   * Photos taken on this device are aliases into the camera roll, so they cost
   * this device nothing and are never removed here.
   */
  freeUpSpace(request: {
    readonly bytes: number;
    readonly scope: "originals" | "originals-and-above-ceiling";
    readonly dryRun?: boolean;
  }): Promise<FreeUpSpaceReport>;
  /**
   * What this node holds, by kind of file.
   *
   * The numbers behind the Storage section. Reads the index rather than probing
   * storage — asking the filesystem per record is hundreds of thousands of
   * calls once stand-ins land.
   */
  storageReport(): StorageReport;
  close(): Promise<void>;
}

export interface StorageReport {
  /**
   * Bytes held per resident-set group: `stand-in:<category>`,
   * `original:<category>` for an original a stand-in can replace, and `kept`
   * for every file no stand-in can replace.
   */
  readonly groups: Readonly<Record<string, number>>;
  readonly heldBytes: number;
}

/** A record in the shape the residency decision reads. */
function candidateOf(record: DataRecord): BlobCandidate {
  return {
    recordId: record.id,
    objectStorageKey: record.objectStorageKey,
    sizeBytes: record.sizeBytes,
    type: record.type,
    parentId: record.parentId,
    appId: null,
    standInRole: record.standInRole ?? null,
    fidelity: record.fidelity ?? null,
  };
}

/**
 * Build the phone's node.
 *
 * Everything injected rather than constructed: the op-sqlite driver, the object
 * storage and the transport are the three things that genuinely need React
 * Native, and taking them as arguments is what lets the whole assembly run in
 * Node against fakes — including a real sync exchange, which is otherwise the
 * kind of thing nobody finds out about until a device is in hand.
 */
export async function createMobileNode(options: MobileNodeOptions): Promise<MobileNode> {
  const databaseAdapter = new SqliteDatabaseAdapter({
    path: options.databasePath,
    driver: options.sqliteDriver,
  });
  await databaseAdapter.init();

  // The alias table is created before anything else touches object storage,
  // because from here on `localObjectStorage` *is* the overlay and every
  // `has()` on it may consult the table.
  const mediaAliases = options.deviceMedia
    ? createSqliteMediaAliasStore({ db: databaseAdapter.getRawDatabase() })
    : null;
  // Built on the same condition as the alias table, because it answers a
  // question only a node that reads a camera roll can ask.
  const importCursor = options.deviceMedia
    ? createSqliteImportCursorStore({ db: databaseAdapter.getRawDatabase() })
    : null;
  // Same shape, its own table. See `MobileNode.videoDurationCursor`.
  const videoDurationCursor = options.deviceMedia
    ? createSqliteImportCursorStore({
        db: databaseAdapter.getRawDatabase(),
        table: VIDEO_DURATION_CURSOR_TABLE,
      })
    : null;
  // Built on the same condition as the alias table, because the sweep it
  // positions walks that table. See `MobileNode.derivationCursor`.
  const derivationCursor = options.deviceMedia
    ? createSqliteScanCursorStore({
        db: databaseAdapter.getRawDatabase(),
        table: DERIVATION_CURSOR_TABLE,
      })
    : null;
  const fullDerivationCursor = options.deviceMedia
    ? createSqliteScanCursorStore({
        db: databaseAdapter.getRawDatabase(),
        table: FULL_DERIVATION_CURSOR_TABLE,
      })
    : null;
  const settings = createDeviceSettingsStore({ db: databaseAdapter.getRawDatabase() });
  const ceilingsFor = (s: DeviceSettings): SyncDownCeilings => ({
    ...DEFAULT_SYNC_DOWN_CEILINGS.phone,
    image: s.imageCeiling,
  });
  // Built on the same condition, because import is the only writer and import
  // is what a camera roll makes possible. See `media/motion-index.ts`.
  const motionIndex = options.deviceMedia
    ? createSqliteMotionIndexStore({ db: databaseAdapter.getRawDatabase() })
    : null;
  const localObjectStorage =
    mediaAliases && options.deviceMedia
      ? new DeviceMediaObjectStorage({
          inner: options.localObjectStorage,
          aliases: mediaAliases,
          fs: options.deviceMedia.fs,
        })
      : options.localObjectStorage;

  await localObjectStorage.init();

  const clock = createHLCClock({
    nodeId: options.nodeId,
    ...(options.wallClock ? { wallClockFunction: options.wallClock } : {}),
  });

  // The sync state lives in the same database file as the records, through the
  // raw handle. One file rather than two is not tidiness: a phone can be killed
  // between two writes, and a watermark that lives in a different file from the
  // records it describes can be newer than them after a crash — which is
  // exactly the state that makes a record invisible to sync forever.
  const syncState = createSqliteSyncStateStore({
    db: databaseAdapter.getRawDatabase(),
  });

  // The library's settings file arrives like any other file. A phone with no
  // cloud is the whole library, so its defaults are the library's value.
  const librarySettings = createLibrarySettings({
    db: databaseAdapter,
    storage: localObjectStorage,
    clock,
    cloudConfigured: () => Boolean(options.cloud),
  });
  await librarySettings.refresh();

  // Every file no stand-in can replace arrives here; stand-ins arrive up to
  // this device's ceiling; everything else waits to be asked for. Nothing is
  // removed except by the person's "Free up space".
  const residency = createResidencyManager({
    localDb: databaseAdapter.getRawDatabase(),
    databaseAdapter,
    localObjectStorage,
    // A phone is never the cloud node. `starkeep/no-cloud` is a constraint
    // about cloud storage; a handset holding such a record is the intended
    // outcome, not a violation.
    isCloudNode: false,
    ceilings: options.ceilings ?? ceilingsFor(settings.get()),
    standards: () => librarySettings.standards(),
    // A camera-roll photograph is an alias: the overlay answers `has()` for
    // it, but its bytes are the media store's. Removing the key would drop
    // the alias and free nothing, so "Free up space" never offers it.
    ...(mediaAliases ? { borrowsBytes: (key: string) => mediaAliases.get(key) !== null } : {}),
  });

  // No cloud, no engine. Not a stub or an offline transport that queues: there
  // is genuinely nobody to exchange with, and an engine that pretends otherwise
  // would advance watermarks against a peer that does not exist.
  const engine = options.cloud
    ? createSyncEngine({
        localDatabaseAdapter: databaseAdapter,
        localObjectStorage,
        remoteObjectStorage: options.cloud.remoteObjectStorage,
        transport: options.cloud.transport,
        clock,
        syncState,
        maxBytes: MOBILE_MAX_BYTES,
        maxItems: MOBILE_MAX_ITEMS,
        transferConcurrency: MOBILE_TRANSFER_CONCURRENCY,
        residency: residencyHooks(residency),
      })
    : null;

  /** A round may have brought a settings file; read it before anything stamps. */
  async function afterRound<T>(result: T): Promise<T> {
    try {
      await librarySettings.refresh();
    } catch (err) {
      console.warn(`[starkeep:settings] could not read the library's settings: ${String(err)}`);
    }
    return result;
  }

  /**
   * One engine, one operation at a time — the phone's copy of the rule the
   * local-data-server learned the hard way (`engine-runner.ts`).
   *
   * `syncState` is read-modify-write throughout and has no compare-and-set: a
   * round loads the watermarks, the repair floors and the inbound floors, works
   * out where they should be, and writes them back. Two of those at once
   * compute from the same snapshot and the later write wins — a watermark can
   * go backwards (survivable, it costs a re-ship) and a repair floor can be
   * dropped (not survivable, it is the only record that a hole still needs
   * filling).
   *
   * Today the phone is single-flight only because `HomeScreen` disables the
   * buttons while one is running, which is a lock made of UI state and stops
   * being one the moment sync is scheduled as background work — which is
   * exactly what item 14's work graph is for. Serializing here rather than there
   * means the guarantee does not depend on which caller happens to be next.
   *
   * A queue rather than the LDS's coalescing drain: the callers here are a
   * person pressing a button, and someone who presses "Check backup" during a
   * sync wants the check, not a silent no-op.
   */
  const scanCursor = createSqliteScanCursorStore({ db: databaseAdapter.getRawDatabase() });

  let engineLock: Promise<unknown> = Promise.resolve();
  function serialized<T>(body: () => Promise<T>): Promise<T> {
    // `then(body, body)` rather than `then(body)`: a rejected predecessor must
    // still hand the queue on, or one failed round wedges the node.
    const next = engineLock.then(body, body);
    engineLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    databaseAdapter,
    objectStorage: localObjectStorage,
    mediaAliases,
    importCursor,
    videoDurationCursor,
    derivationCursor,
    fullDerivationCursor,
    motionIndex,
    engine,
    residency,
    librarySettings,
    deviceSettings: () => settings.get(),
    setImageCeiling(ceiling) {
      const next = settings.update({ imageCeiling: ceiling });
      residency.setCeilings(ceilingsFor(next));
      // From the top, so the next scan reaches every stand-in the new ceiling
      // covers rather than only those past where the last scan stopped.
      scanCursor.set(null);
      return next;
    },
    setDerivePhotoStandIns(on) {
      return settings.update({ derivePhotoStandIns: on });
    },
    exchange: async () => (engine ? serialized(() => engine.exchange().then(afterRound)) : null),
    sync: async (syncOptions) =>
      engine ? serialized(() => engine.sync(syncOptions).then(afterRound)) : null,

    async acquireQueued(acquireOptions) {
      // No cloud means nobody to fetch from.
      if (!engine) return null;
      // Serialized behind the same lock as a round: both drive the one engine.
      return serialized(() =>
        runAcquisition({
          engine,
          manager: residency,
          databaseAdapter,
          // One round's worth of bytes per tick, for the reason
          // `MOBILE_MAX_BYTES` gives: the OS decides when the app stops, and a
          // unit that takes a minute is a unit that gets abandoned partway,
          // over and over.
          maxBytes: acquireOptions?.maxBytes ?? MOBILE_MAX_BYTES,
        }),
      );
    },

    async scanForAcquirable(scanOptions) {
      // Not serialized behind the engine lock: it writes no sync state and
      // transfers nothing. It writes deferred rows, and `index.defer` is
      // structurally unable to disturb a row a concurrent round is landing.
      const cursor = scanCursor.get();
      if (cursor === null) {
        // A new sweep starts by reconciling the index against the disk, so
        // bytes that went away behind its back read as missing and are queued.
        try {
          await residency.reconcile();
        } catch (err) {
          console.warn(`[starkeep:residency] could not reconcile: ${String(err)}`);
        }
      }
      const result = await scanForAcquirable({
        databaseAdapter,
        consider: (candidate) => residency.considerForAcquisition(candidate),
        cursor,
        maxRecords: scanOptions?.maxRecords ?? MOBILE_SCAN_RECORDS,
      });
      // Written after the page rather than before it, so a process killed
      // mid-page repeats that page rather than skipping it. Repeating is free —
      // the scan is idempotent and its only output is deferred rows.
      scanCursor.set(result.nextCursor);
      return { queued: result.queued, complete: result.nextCursor === null };
    },

    verify: async () => (engine ? serialized(() => engine.verify()) : null),
    // Deliberately *not* serialized behind the engine lock. It writes no sync
    // state, and making someone wait for a multi-minute drain before their
    // photo appears would defeat the point of an on-demand fetch. The transfer
    // layer already handles the overlap: a fetch for a key the round is moving
    // joins that transfer rather than racing it.
    async fetchBlob(record) {
      if (!engine || !record.objectStorageKey) return false;
      return engine.fetchBlob(
        {
          fileHash: record.contentHash || record.objectStorageKey,
          objectStorageKey: record.objectStorageKey,
          sizeBytes: record.sizeBytes,
          ...(record.mimeType ? { mimeType: record.mimeType } : {}),
        },
        // The real candidate rather than one derived from the manifest, so the
        // index records the file under the group it actually belongs to.
        candidateOf(record),
      );
    },

    async noteDerived(record) {
      await residency.noteArrival(candidateOf(record));
    },

    async freeUpSpace(request) {
      const probes: ReplicaProbe[] = options.cloud
        ? [{ nodeId: "cloud", storage: options.cloud.remoteObjectStorage }]
        : [];
      return residency.freeUpSpace({ ...request, probes });
    },

    storageReport() {
      const groups = residency.usageByGroup();
      return {
        groups,
        heldBytes: Object.values(groups).reduce((sum, bytes) => sum + bytes, 0),
      };
    },

    async close() {
      await databaseAdapter.close();
      await localObjectStorage.close();
    },
  };
}
