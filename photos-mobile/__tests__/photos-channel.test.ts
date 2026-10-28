/**
 * Photos' own channel on the phone, and the captions it carries.
 *
 * The phone runs a second engine against `<cloud>/apps/photos`, beside the
 * Drive channel's, over Photos' private tables. These cases assemble the node
 * as the app does and sync it against an in-process peer that holds Photos'
 * tables in SQLite, the way a desktop or the cloud does. See
 * `plan-mobile-private-channel-and-captions-2026-10-27.md`, phases 4 and 5.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHLCClock, serializeHLC } from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import {
  initializeLocalSchema,
  registerAppSyncableNamespace,
  SqliteAppSyncableApplier,
  SqliteAppSyncableNamespaceStore,
  appSyncableTableName,
  type AppSyncableDeclaration,
} from "@starkeep/storage-sqlite";
import {
  createInProcessSyncTransport,
  createSqliteSyncStateStore,
  type SyncTransport,
} from "@starkeep/sync-engine";
import { FILE_RECORDS_TABLE } from "@starkeep/shared-space-api";
import { MAX_CAPTION_LENGTH, photosSyncableSchema } from "@starkeep/photos-info";
import { createMobileNode, type MobileNode, type MobileNodeOptions } from "../src/node";
import { createOpSqliteDriver, type OpSqliteConnection } from "../src/db/op-sqlite-driver";
import { ExpoObjectStorageAdapter } from "../src/storage/expo-object-storage";
import { CaptionEditBlockedError } from "../src/photos/captions";
import { createChannelSyncStateStore } from "../src/work/channel-sync-state";
import { fakeExpoFs } from "./helpers/fake-expo-fs";

const USER = "8f1c2d3e-0000-4000-8000-0000000000aa";
const ENRICHED = appSyncableTableName("photos", "image_enriched");
const FILE_ROWS = appSyncableTableName("photos", FILE_RECORDS_TABLE);

/** op-sqlite's shape over one real SQLite database, which survives a close. */
function opSqliteOver(db: DatabaseSync) {
  const connection: OpSqliteConnection = {
    executeSync(query: string, params?: unknown[]) {
      const stmt = db.prepare(query);
      if (/^\s*(select|pragma|with)/i.test(query)) {
        return { rows: stmt.all(...((params ?? []) as never[])) as unknown[] };
      }
      stmt.run(...((params ?? []) as never[]));
      return { rows: [] };
    },
    close() {},
  };
  return { open: () => connection };
}

/**
 * A peer holding Photos' tables, as a desktop or the cloud does: the node's
 * other half of the Photos channel. Shared records never travel here.
 */
function photosPeer() {
  const db = new DatabaseSync(":memory:");
  initializeLocalSchema(db);
  registerAppSyncableNamespace(db, "photos", photosSyncableSchema as AppSyncableDeclaration);
  const namespaces = new SqliteAppSyncableNamespaceStore(db);
  const applier = new SqliteAppSyncableApplier(db, namespaces);
  const clock = createHLCClock({ nodeId: "desktop" });
  const storage = new MockObjectStorageAdapter();
  const transport = createInProcessSyncTransport({
    databaseAdapter: new MockDatabaseAdapter(),
    clock,
    objectStorage: storage,
    syncSharedRecords: false,
    appSyncableSource: { namespaces, applier },
  });
  return {
    db,
    storage,
    transport,
    /** A row the desktop wrote, as its own app-specific view would. */
    write(row: Record<string, unknown>) {
      const ts = clock.now();
      applier.apply({
        timestamp: ts,
        appId: "photos",
        table: "image_enriched",
        op: "insert",
        row: { ...row, updated_at: serializeHLC(ts), deleted_at: null },
      });
    },
    /**
     * A private file the desktop holds, as Photos' cover image is: the bytes in
     * the peer's storage and their row in the reserved table.
     */
    async writeFile(name: string): Promise<string> {
      const key = `apps/photos/${USER}/syncable/covers/${name}`;
      await storage.put(key, new Uint8Array([1, 2, 3]));
      const ts = clock.now();
      applier.apply({
        timestamp: ts,
        appId: "photos",
        table: FILE_RECORDS_TABLE,
        op: "insert",
        row: {
          id: key,
          object_storage_key: key,
          content_hash: "e".repeat(64),
          mime_type: "image/jpeg",
          size_bytes: 3,
          original_filename: name,
          origin_app_id: "photos",
          created_at: "2026-10-27T00:00:00.000Z",
          updated_at: serializeHLC(ts),
          deleted_at: null,
        },
      });
      return key;
    },
    row(recordId: string) {
      return db
        .prepare(`SELECT caption, title FROM ${ENRICHED} WHERE record_id = ?`)
        .get(recordId) as { caption: string | null; title: string | null } | undefined;
    },
  };
}

/** A Drive channel peer with nothing in it. */
function drivePeer() {
  const storage = new MockObjectStorageAdapter();
  return {
    storage,
    transport: createInProcessSyncTransport({
      databaseAdapter: new MockDatabaseAdapter(),
      clock: createHLCClock({ nodeId: "cloud" }),
      objectStorage: storage,
    }),
  };
}

async function phoneNode(
  db: DatabaseSync,
  cloud: MobileNodeOptions["cloud"] | null,
  harness: ReturnType<typeof fakeExpoFs> = fakeExpoFs(),
): Promise<MobileNode> {
  return createMobileNode({
    nodeId: "phone-a",
    databasePath: "/data/starkeep/local.sqlite",
    sqliteDriver: createOpSqliteDriver(opSqliteOver(db)),
    localObjectStorage: new ExpoObjectStorageAdapter({ fs: harness.fs, basePath: "/docs/objects" }),
    ...(cloud ? { cloud } : {}),
  });
}

function cloudOf(
  drive: ReturnType<typeof drivePeer>,
  photos: { transport: SyncTransport; storage: MockObjectStorageAdapter } | null,
): NonNullable<MobileNodeOptions["cloud"]> {
  return {
    transport: drive.transport,
    remoteObjectStorage: drive.storage,
    readSyncUser: async () => ({ userId: USER }),
    readDeploymentSettings: async () => null,
    ...(photos
      ? { photos: { transport: photos.transport, remoteObjectStorage: photos.storage } }
      : {}),
  };
}

let db: DatabaseSync;
let peer: ReturnType<typeof photosPeer>;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  peer = photosPeer();
});

describe("bring-up", () => {
  it("creates Photos' private tables, and again on the next launch without harm", async () => {
    await phoneNode(db, null);
    await phoneNode(db, null);
    const ns = new SqliteAppSyncableNamespaceStore(db).get("photos");
    expect(ns?.tableNames).toContain("image_enriched");
    expect(new SqliteAppSyncableNamespaceStore(db).list()).toHaveLength(1);
  });

  it("builds the Photos channel's engine beside Drive's on a node with a cloud", async () => {
    const node = await phoneNode(db, cloudOf(drivePeer(), peer));
    expect(node.engine).not.toBeNull();
    expect(node.photosEngine).not.toBeNull();
    expect(node.photosEngine).not.toBe(node.engine);
  });

  it("builds neither engine on a node with no cloud", async () => {
    const node = await phoneNode(db, null);
    expect(node.engine).toBeNull();
    expect(node.photosEngine).toBeNull();
    expect(await node.syncPhotos()).toBeNull();
  });
});

describe("captions", () => {
  it("pulls a caption the desktop wrote", async () => {
    peer.write({ record_id: "r1", caption: "A cat", title: "Cat", date_taken_override: null });
    const node = await phoneNode(db, cloudOf(drivePeer(), peer));
    expect(await node.captions.get("r1")).toBeNull();

    const result = await node.syncPhotos();
    expect(result?.complete).toBe(true);
    expect(await node.captions.get("r1")).toBe("A cat");
  });

  it("refuses an edit until the Photos channel has completed a pull, and says why", async () => {
    const node = await phoneNode(db, cloudOf(drivePeer(), peer));
    expect(node.captions.editBlockedReason()).toMatch(/once this phone has synced/);
    await expect(node.captions.set("r1", "Too soon")).rejects.toThrow(CaptionEditBlockedError);

    await node.syncPhotos();
    expect(node.captions.editBlockedReason()).toBeNull();
  });

  it("remembers the completed pull across a relaunch", async () => {
    await (await phoneNode(db, cloudOf(drivePeer(), peer))).syncPhotos();
    const relaunched = await phoneNode(db, cloudOf(drivePeer(), peer));
    expect(relaunched.captions.editBlockedReason()).toBeNull();
  });

  it("refuses an edit on a phone nobody signed in on", async () => {
    const node = await phoneNode(db, null);
    expect(node.captions.editBlockedReason()).toMatch(/Sign in/);
  });

  it("ships an edit to the peer, keeping the title the desktop set", async () => {
    peer.write({ record_id: "r1", caption: "A cat", title: "Cat", date_taken_override: null });
    const node = await phoneNode(db, cloudOf(drivePeer(), peer));
    await node.syncPhotos();

    expect(await node.captions.set("r1", "A sleeping cat")).toBe("A sleeping cat");
    expect(await node.captions.get("r1")).toBe("A sleeping cat");
    await node.syncPhotos();
    expect(peer.row("r1")).toEqual({ caption: "A sleeping cat", title: "Cat" });
  });

  it("stores null for an empty caption and keeps the row", async () => {
    peer.write({ record_id: "r1", caption: "A cat", title: "Cat", date_taken_override: null });
    const node = await phoneNode(db, cloudOf(drivePeer(), peer));
    await node.syncPhotos();

    expect(await node.captions.set("r1", "")).toBeNull();
    expect(await node.captions.get("r1")).toBeNull();
    await node.syncPhotos();
    expect(peer.row("r1")).toEqual({ caption: null, title: "Cat" });
  });

  it("refuses a caption over the shared limit", async () => {
    const node = await phoneNode(db, cloudOf(drivePeer(), peer));
    await node.syncPhotos();
    await expect(node.captions.set("r1", "x".repeat(MAX_CAPTION_LENGTH + 1))).rejects.toThrow(
      RangeError,
    );
    expect(await node.captions.get("r1")).toBeNull();
  });
});

describe("one sync, two channels", () => {
  it("runs Drive's channel first, then Photos'", async () => {
    const order: string[] = [];
    const drive = drivePeer();
    const spy = (name: string, transport: SyncTransport): SyncTransport => ({
      ...transport,
      exchange: async (request) => {
        order.push(name);
        return transport.exchange(request);
      },
    });
    const node = await phoneNode(db, {
      ...cloudOf(drive, peer),
      transport: spy("drive", drive.transport),
      photos: { transport: spy("photos", peer.transport), remoteObjectStorage: peer.storage },
    });
    await node.sync();
    expect(order[0]).toBe("drive");
    expect(order.at(-1)).toBe("photos");
    expect(order.indexOf("photos")).toBeGreaterThan(order.lastIndexOf("drive"));
  });

  it("returns the Drive round's result when the Photos channel fails", async () => {
    const failing: SyncTransport = {
      ...peer.transport,
      exchange: async () => {
        throw new Error("the cloud answered 403");
      },
    };
    const node = await phoneNode(db, {
      ...cloudOf(drivePeer(), peer),
      photos: { transport: failing, remoteObjectStorage: peer.storage },
    });
    const result = await node.sync();
    expect(result?.complete).toBe(true);
    // Not pulled, so editing stays closed.
    expect(node.captions.editBlockedReason()).not.toBeNull();
  });

  it("syncs captions with the Drive channel in one sync", async () => {
    peer.write({ record_id: "r1", caption: "A cat", title: null, date_taken_override: null });
    const node = await phoneNode(db, cloudOf(drivePeer(), peer));
    await node.sync();
    expect(await node.captions.get("r1")).toBe("A cat");
  });
  it("skips the Photos channel when the sync is aborted during Drive's round", async () => {
    // The app going to the background aborts the signal part-way through.
    const signal = { aborted: false };
    let photosExchanges = 0;
    const drive = drivePeer();
    const node = await phoneNode(db, {
      ...cloudOf(drive, peer),
      transport: {
        ...drive.transport,
        exchange: async (request) => {
          signal.aborted = true;
          return drive.transport.exchange(request);
        },
      },
      photos: {
        transport: {
          ...peer.transport,
          exchange: async (request) => {
            photosExchanges++;
            return peer.transport.exchange(request);
          },
        },
        remoteObjectStorage: peer.storage,
      },
    });
    await node.sync({ signal });
    expect(photosExchanges).toBe(0);
  });

  it("runs the Photos channel when Drive's round throws, then throws Drive's error", async () => {
    peer.write({ record_id: "r1", caption: "A cat", title: null, date_taken_override: null });
    const drive = drivePeer();
    const node = await phoneNode(db, {
      ...cloudOf(drive, peer),
      transport: {
        ...drive.transport,
        exchange: async () => {
          throw new Error("Drive's channel answered 502");
        },
      },
    });
    await expect(node.sync()).rejects.toThrow(/Drive's channel answered 502/);
    expect(await node.captions.get("r1")).toBe("A cat");
  });
});

describe("two channels, two sync states", () => {
  /** The Drive channel's state and the Photos channel's, read as each engine reads its own. */
  async function states() {
    const drive = createSqliteSyncStateStore({ db: db as never });
    const photos = createChannelSyncStateStore(db as never, drive, "photos");
    return {
      drive: {
        watermarks: await drive.getWatermarks(),
        peer: await drive.getPeerWatermarks(),
      },
      photos: {
        watermarks: await photos.getWatermarks(),
        peer: await photos.getPeerWatermarks(),
      },
    };
  }

  it("keeps each channel's watermarks to the rows that channel carried", async () => {
    peer.write({ record_id: "r1", caption: "A cat", title: null, date_taken_override: null });
    const node = await phoneNode(db, cloudOf(drivePeer(), peer));
    await node.sync();
    const afterPull = await states();
    // The desktop's row came over the Photos channel and only there.
    expect(Object.keys(afterPull.photos.watermarks)).toContain("desktop");
    expect(Object.keys(afterPull.drive.watermarks)).not.toContain("desktop");

    await node.captions.set("r1", "A sleeping cat");
    await node.syncPhotos();
    const afterPush = await states();
    // The phone's caption was confirmed by the Photos peer, not Drive's.
    expect(Object.keys(afterPush.photos.peer)).toContain("phone-a");
    expect(Object.keys(afterPush.drive.peer)).not.toContain("phone-a");
    // And the Photos round left Drive's state exactly as it was.
    expect(afterPush.drive).toEqual(afterPull.drive);

    // A Drive round leaves the Photos channel's state alone.
    await node.exchange();
    expect((await states()).photos).toEqual(afterPush.photos);
  });
});

describe("Photos' private files", () => {
  it("applies a file row from the peer and leaves its bytes in the cloud", async () => {
    const key = await peer.writeFile("cover.jpg");
    const harness = fakeExpoFs();
    const node = await phoneNode(db, cloudOf(drivePeer(), peer), harness);

    const result = await node.syncPhotos();
    expect(result?.complete).toBe(true);
    expect(db.prepare(`SELECT id FROM ${FILE_ROWS}`).all()).toEqual([{ id: key }]);
    // No byte of the file reached the phone's object store.
    expect([...harness.files.keys()].filter((path) => path.includes("covers"))).toEqual([]);
    // Declining is terminal: the round still counts as a completed pull.
    expect(node.captions.editBlockedReason()).toBeNull();
  });
});
