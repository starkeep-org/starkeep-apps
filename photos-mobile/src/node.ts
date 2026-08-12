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
 * 2. **It has a budget that will actually bind.** A laptop with no retention
 *    policy wants every blob; a phone with 8 GB against a 60k-item library is
 *    the only honest consumer of `Elided`, and the reason the media plan calls
 *    this phase the validation of Phase 0's residency work.
 * 3. **Its rounds are smaller.** See {@link MOBILE_MAX_BYTES}.
 */

import { createHLCClock } from "@starkeep/protocol-primitives";
import { SqliteDatabaseAdapter, type SqliteDriver } from "@starkeep/storage-sqlite";
import {
  createSyncEngine,
  createSqliteSyncStateStore,
  createResidencyManager,
  residencyHooks,
  type EvictionOutcome,
  type NodeRetentionPolicy,
  type OverrideRule,
  type ReplicaProbe,
  type ResidencyManager,
  type SyncEngine,
  type SyncOptions,
  type SyncResult,
  type VerifyResult,
  budgetBytesFor,
  budgetLineFor,
  parseSizeClass,
  retentionRowFor,
  PLATFORM_NAMESPACE,
  type SyncTransport,
} from "@starkeep/sync-engine";
import { totalBudgetBytes } from "./retention";
import type { DataRecord } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createSqliteMediaAliasStore, type MediaAliasStore } from "./media/media-alias";
import { DeviceMediaObjectStorage } from "./storage/device-media-storage";
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
   * The phone's retention policy.
   *
   * Optional, and its absence means "keep everything" — the same default a
   * laptop has. That is deliberately the *wrong* setting for a phone and is
   * still the right default: a node that cannot yet be told its budget must not
   * silently start declining data, because the failure mode of over-fetching is
   * a full disk and the failure mode of under-fetching is a photo that is
   * quietly nowhere.
   */
  readonly retention?: NodeRetentionPolicy;
  /** Per-record overrides as rules over labels. Node-local, like pins. */
  readonly overrideRules?: readonly OverrideRule[];
  /**
   * Which label names a record's size class.
   *
   * Defaults to `photos/rendition` because this is the photos app and that is
   * its own ladder — naming it here is a choice the app is entitled to make.
   * The same line inside `@starkeep/sync-engine` would be a bug, and was one
   * until this assembly moved out of core: platform code that names an app has
   * quietly decided every future app's labels for it.
   *
   * Still configurable so the ladder can be respecified without a change here.
   *
   * A single entry, unlike a laptop's map of every installed app: an embedded
   * node has no app registry to read, because it *is* the app. Its budget
   * covers only its own bytes, so its own ladder is the only one it can see.
   */
  readonly sizeClassKeys?: Readonly<Record<string, string>>;
  /** Replicas elsewhere required before this node may drop its only copy. */
  readonly minimumReplicas?: number;
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
   * Null when no retention policy was supplied — meaning this node wants every
   * blob, exactly as an unconfigured laptop does.
   */
  readonly residency: ResidencyManager | null;
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
   * The reversal half of eliding, and the reason a budget on a phone is a
   * budget rather than data loss. An elided record advances the watermark — that
   * is what makes declining a blob a terminal state instead of a permanent
   * retry — so the cloud will never offer those bytes again and no amount of
   * syncing brings them back. This is the only route, which is why the phone,
   * as the only node that actually elides anything, has to be the one that
   * exposes it.
   *
   * Resolves false when there is no cloud to fetch from, when the record has no
   * blob, or when the transfer failed. It does *not* resolve false for a key a
   * sync round is already moving: that call joins the round's transfer and
   * reports its outcome, because "wait a moment" and "it failed" are different
   * answers and the placeholder should only stay for one of them.
   */
  fetchBlob(record: DataRecord): Promise<boolean>;
  /**
   * Free space: reconcile what this node believes it holds against what it
   * actually holds, then run an eviction pass over every class and namespace
   * that is over budget.
   *
   * ## Why the two are one call
   *
   * Eviction chooses its candidates from the resident-set index, and the index
   * is a *cache* of a fact the filesystem also knows. A pass run against a stale
   * index deletes keys that are not there (harmless) and, worse, believes a
   * class is full when its bytes are already gone — so it works to a target it
   * has already passed. Reconciling first is what makes the pass's arithmetic
   * describe the disk.
   *
   * ## What it will refuse to do
   *
   * Delete anything it cannot prove survives elsewhere. The probe is the cloud,
   * so on a device that has never been paired there is nothing to ask and the
   * pass frees nothing and says why (`EvictionOutcome.refusal`). That is the
   * intended behaviour, not a degraded one: this is the only code in the app
   * that destroys a user's data, and "the budget is full" is not evidence that
   * a photograph is safe somewhere.
   *
   * It also cannot touch a photograph taken on this device. Those are aliases to
   * the camera roll, so they are not in the index at all, and
   * `DeviceMediaObjectStorage.delete()` drops an alias rather than an asset even
   * if something asked.
   *
   * Returns one outcome per pass — empty on a node with no retention policy,
   * where there is no budget to be over.
   */
  reclaimSpace(): Promise<EvictionOutcome[]>;
  /**
   * Keep this record on this device regardless of budget, or stop doing so.
   *
   * Node-local and deliberately not a label: a pin shared as a label would let
   * one device's preference silently rewrite every other device's cache policy.
   *
   * Pins **win** over every budget, and they still count
   * against the line's budget — so pinning a lot makes the overage visible
   * rather than swallowing it. They do not beat a record constraint: a
   * `starkeep/no-cloud` record is refused by the cloud whatever this device
   * wants.
   */
  setPinned(recordId: string, pinned: boolean): void;
  isPinned(recordId: string): boolean;
  /**
   * Record that someone looked at this record on this device.
   *
   * The strongest signal there is about what a phone should keep, and until this
   * had a caller on the *viewing* path it was recorded only when a fetch
   * happened — which meant `last_opened_at_ms` was written exactly for records
   * this device had already decided it did not want, so the eviction ordering's
   * never-opened-first tier collapsed into one tier where every candidate tied.
   *
   * It matters more now, not less. The column used to be one input among
   * several — a date window, a keep rule, a budget — and it is now the *primary*
   * term of the only ordering the system has, on both the eviction side and the
   * admission side.
   *
   * Safe to call for a record whose bytes are not here: the pin table and the
   * resident-set row are separate things, and a record with no held blob simply
   * has no row to stamp yet.
   */
  noteOpened(recordId: string): void;
  /**
   * What this node is holding, per class, against what its policy allows.
   *
   * The numbers behind the Storage section. Reads the index rather than probing
   * storage, which is the whole reason the index exists — asking the filesystem
   * per record is hundreds of thousands of calls once renditions land.
   */
  storageReport(): StorageReport;
  close(): Promise<void>;
}

/** One class's line in the Storage section. */
export interface StorageClassUsage {
  readonly sizeClass: string;
  readonly heldBytes: number;
  /** The budget of the line this class is charged to. Lines can be shared. */
  readonly budgetBytes: number;
  /**
   * Whether the class is pulled during a sync round.
   *
   * False reads as "kept once you open it" in the Storage section, and it is
   * the whole of what the old four-value keep rule had left to say — the other
   * three values were predictions of what the eviction order does anyway.
   */
  readonly prefetch: boolean;
}

export interface StorageReport {
  readonly classes: readonly StorageClassUsage[];
  readonly heldBytes: number;
  readonly budgetBytes: number;
  /** False when this node has no retention policy, so nothing binds. */
  readonly configured: boolean;
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

  // Without a policy there is no budget to enforce and no class to resolve, so
  // the engine runs without the hook and every blob is wanted. That is the same
  // default a laptop has, and it is the right one: a node that has not been told
  // its budget must not silently start declining data, because the failure mode
  // of over-fetching is a full disk and the failure mode of under-fetching is a
  // photo that is quietly nowhere.
  const residency = options.retention
    ? createResidencyManager({
        localDb: databaseAdapter.getRawDatabase(),
        databaseAdapter,
        localObjectStorage,
        sizeClassKeys: options.sizeClassKeys ?? { photos: "rendition" },
        // A phone is never the cloud node. `starkeep/no-cloud` is a constraint
        // about cloud storage; a handset holding such a record is the intended
        // outcome, not a violation.
        isCloudNode: false,
        policy: options.retention,
        overrideRules: options.overrideRules ?? [],
        durability: { minimumReplicas: options.minimumReplicas ?? 1 },
      })
    : null;

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
        ...(residency ? { residency: residencyHooks(residency) } : {}),
      })
    : null;

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
    engine,
    residency,
    exchange: async () => (engine ? serialized(() => engine.exchange()) : null),
    sync: async (syncOptions) =>
      engine ? serialized(() => engine.sync(syncOptions)) : null,
    verify: async () => (engine ? serialized(() => engine.verify()) : null),
    // Deliberately *not* serialized behind the engine lock. It writes no sync
    // state, and making someone wait for a multi-minute drain before their
    // photo appears would defeat the point of an on-demand fetch. The transfer
    // layer already handles the overlap: a fetch for a key the round is moving
    // joins that transfer rather than racing it.
    async fetchBlob(record) {
      if (!engine || !record.objectStorageKey) return false;
      // Opening a photo is the strongest signal there is about what this device
      // should keep, and it is recorded whether or not the fetch succeeds:
      // eviction ordering reads it, and a failed network call does not make the
      // photo less wanted.
      residency?.markOpened(record.id, Date.now());
      return engine.fetchBlob(
        {
          fileHash: record.contentHash || record.objectStorageKey,
          objectStorageKey: record.objectStorageKey,
          sizeBytes: record.sizeBytes,
          ...(record.mimeType ? { mimeType: record.mimeType } : {}),
        },
        // The real candidate rather than one derived from the manifest, so the
        // host's class resolver sees the record's labels and the bytes are
        // charged to the budget they actually belong to.
        {
          recordId: record.id,
          objectStorageKey: record.objectStorageKey,
          sizeBytes: record.sizeBytes,
          type: record.type,
          parentId: record.parentId,
          appId: null,
          // Names the namespace a derivative is charged to when no app has
          // labelled it with a rung — so an on-demand fetch lands in the same
          // budget the sync path would have used.
          originAppId: record.originAppId,
          recencyAtMs: null,
          lastOpenedAtMs: Date.now(),
        },
      );
    },
    async reclaimSpace() {
      if (!residency) return [];
      // Reconcile first, always. See the doc comment: a pass run against a
      // stale index works to a target it may already have passed.
      //
      // `unknownKeys` are bytes on disk that no budget knows about — a rendition
      // some future derivation pass wrote, anything that arrived by a route
      // other than a sync pull. They are *reported* and not adopted, because
      // charging them to a budget means resolving which class they belong to,
      // and that needs the record row. Logged rather than silently dropped: on
      // this build the expected count is zero, and a non-zero one is worth
      // knowing about before it becomes a budget that no longer describes the
      // disk.
      try {
        const report = await residency.reconcile();
        if (report.corrected > 0 || report.unknownKeys.length > 0) {
          console.log(
            `[starkeep:residency] reconciled: ${report.confirmed} confirmed, ` +
              `${report.corrected} corrected, ${report.unknownKeys.length} unaccounted`,
          );
        }
      } catch (err) {
        // A reconcile that failed is a reason to be *more* careful, not to skip
        // the pass: the index is then no less accurate than it was a moment ago,
        // and the durability predicate is what actually authorizes a deletion.
        console.warn(`[starkeep:residency] could not reconcile: ${String(err)}`);
      }

      // The cloud is this device's replica, and the only one it can interrogate.
      // With no cloud there are no probes, which is not a degraded eviction pass
      // — it is a pass that will refuse to delete anything needing proof, and
      // say so. That is the correct behaviour for a handset that has never been
      // paired: nothing on it is known to exist anywhere else.
      const probes: ReplicaProbe[] = options.cloud
        ? [{ nodeId: "cloud", storage: options.cloud.remoteObjectStorage }]
        : [];
      return residency.runEviction(probes);
    },

    setPinned(recordId, pinned) {
      residency?.setPinned(recordId, pinned);
    },

    isPinned(recordId) {
      return residency?.isPinned(recordId) ?? false;
    },

    noteOpened(recordId) {
      residency?.markOpened(recordId, Date.now());
    },

    storageReport() {
      if (!residency || !options.retention) {
        return { classes: [], heldBytes: 0, budgetBytes: 0, configured: false };
      }
      const policy = options.retention;
      const held = residency.usageByClass();
      // Every class the policy names, plus any class actually holding bytes that
      // it does not — an unrecognised rung is exactly the thing worth seeing,
      // and a report built only from the policy would hide it.
      const named = [
        ...Object.keys(policy.platform.rows).map((rung) => `${PLATFORM_NAMESPACE}:${rung}`),
        ...Object.entries(policy.apps).flatMap(([appId, app]) =>
          Object.keys(app.rows).map((rung) => `${appId}:${rung}`),
        ),
      ];
      const classes = [...new Set([...named, ...Object.keys(held)])]
        .map((sizeClass) => {
          const budgetLine = budgetLineFor(policy, parseSizeClass(sizeClass));
          return {
            sizeClass,
            heldBytes: held[sizeClass] ?? 0,
            // The line's budget, which several classes may share — an
            // unrecognised rung is pooled with every other one. Reporting it
            // per class is honest about the cap each is measured against; it
            // just is not exclusive to that class.
            budgetBytes: budgetBytesFor(policy, budgetLine),
            prefetch: retentionRowFor(policy, budgetLine).prefetch,
          };
        })
        // Biggest first: what is filling the disk is the question being asked.
        .sort((a, b) => b.heldBytes - a.heldBytes);

      return {
        classes,
        heldBytes: classes.reduce((sum, c) => sum + c.heldBytes, 0),
        budgetBytes: totalBudgetBytes(policy),
        configured: true,
      };
    },

    async close() {
      await databaseAdapter.close();
      await localObjectStorage.close();
    },
  };
}
