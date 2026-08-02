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
 * 3. **Its pages are smaller.** See {@link MOBILE_PAGE_LIMIT}.
 */

import { createHLCClock } from "@starkeep/protocol-primitives";
import { SqliteDatabaseAdapter, type SqliteDriver } from "@starkeep/storage-sqlite";
import {
  createSyncEngine,
  createSqliteSyncStateStore,
  createResidencyManager,
  residencyHooks,
  type NodeRetentionPolicy,
  type OverrideRule,
  type ResidencyManager,
  type SyncEngine,
  type SyncTransport,
} from "@starkeep/sync-engine";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createSqliteMediaAliasStore, type MediaAliasStore } from "./media/media-alias.js";
import { DeviceMediaObjectStorage } from "./storage/device-media-storage.js";
import type { ExpoFileSystem } from "./storage/expo-object-storage.js";

/**
 * How many records one exchange page carries on a phone.
 *
 * Deliberately far below the server's 1000. Constraint 2 of the phase — no work
 * item may assume more than a few seconds — is not a suggestion here: the OS
 * decides when the app stops, and a page that takes thirty seconds to apply is
 * a page that gets abandoned partway on a real handset, over and over, making
 * progress impossible rather than merely slow.
 *
 * Smaller pages mean more round trips, which is the correct trade when the
 * alternative is a round trip that never completes. The watermark makes an
 * abandoned page free to retry, so the only cost of being wrong in this
 * direction is bandwidth.
 */
export const MOBILE_PAGE_LIMIT = 100;

/** Matching scan page — the responder-side equivalent of the same argument. */
export const MOBILE_SCAN_PAGE_SIZE = 100;

export interface MobileNodeOptions {
  readonly nodeId: string;
  /** Where op-sqlite should put the database. */
  readonly databasePath: string;
  readonly sqliteDriver: SqliteDriver;
  readonly localObjectStorage: ObjectStorageAdapter;
  /** The cloud, reached over whatever transport the shell supplies. */
  readonly transport: SyncTransport;
  readonly remoteObjectStorage: ObjectStorageAdapter;
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
   */
  readonly classLabel?: { readonly appId: string; readonly key: string };
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
  readonly engine: SyncEngine;
  /**
   * Null when no retention policy was supplied — meaning this node wants every
   * blob, exactly as an unconfigured laptop does.
   */
  readonly residency: ResidencyManager | null;
  /** Run one exchange. Safe to abandon; the watermark makes it resumable. */
  exchange(): Promise<unknown>;
  close(): Promise<void>;
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
        classLabel: options.classLabel ?? { appId: "photos", key: "rendition" },
        // A phone is never the cloud node. `starkeep/no-cloud` is a constraint
        // about cloud storage; a handset holding such a record is the intended
        // outcome, not a violation.
        isCloudNode: false,
        policy: options.retention,
        overrideRules: options.overrideRules ?? [],
        durability: { minimumReplicas: options.minimumReplicas ?? 1 },
      })
    : null;

  const engine = createSyncEngine({
    localDatabaseAdapter: databaseAdapter,
    localObjectStorage,
    remoteObjectStorage: options.remoteObjectStorage,
    transport: options.transport,
    clock,
    syncState,
    pageLimit: MOBILE_PAGE_LIMIT,
    scanPageSize: MOBILE_SCAN_PAGE_SIZE,
    ...(residency ? { residency: residencyHooks(residency) } : {}),
  });

  return {
    databaseAdapter,
    objectStorage: localObjectStorage,
    mediaAliases,
    engine,
    residency,
    exchange: () => engine.exchange(),
    async close() {
      await databaseAdapter.close();
      await localObjectStorage.close();
    },
  };
}
