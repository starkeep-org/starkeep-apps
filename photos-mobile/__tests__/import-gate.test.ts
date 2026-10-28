/**
 * The import gate: a fresh library waits for a sign-in and a completed pull, or
 * for the person's choice to import without signing in.
 *
 * A reset phone imported before it pulled, so it could not see the records it
 * was about to write over (`findings-phone-reinstall-dedup-2026-10-28.md`).
 * These cases pin the decision, its storage, and the node's wiring of both.
 */
import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createHLCClock, type DataRecord, type StarkeepId } from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, MockObjectStorageAdapter, type RawDatabase } from "@starkeep/storage-adapter";
import { createInProcessSyncTransport, createSqliteSyncStateStore } from "@starkeep/sync-engine";
import { createImportGateStore, importGateOf, type ImportGateFacts } from "../src/media/import-gate";
import { createMobileNode, type MobileNode } from "../src/node";
import { createOpSqliteDriver, type OpSqliteConnection } from "../src/db/op-sqlite-driver";
import { ExpoObjectStorageAdapter } from "../src/storage/expo-object-storage";
import { fakeExpoFs } from "./helpers/fake-expo-fs";

const FRESH: ImportGateFacts = {
  imported: false,
  hasCloud: false,
  drivePulled: false,
  importWithoutPull: false,
};

describe("importGateOf", () => {
  it("offers sign-in to a fresh library with no cloud", () => {
    expect(importGateOf(FRESH)).toBe("sign-in");
  });

  it("waits for the first pull once signed in", () => {
    expect(importGateOf({ ...FRESH, hasCloud: true })).toBe("first-pull");
  });

  it("opens after the first pull", () => {
    expect(importGateOf({ ...FRESH, hasCloud: true, drivePulled: true })).toBe("open");
  });

  it("opens on the choice to import without signing in", () => {
    expect(importGateOf({ ...FRESH, importWithoutPull: true })).toBe("open");
  });

  // An upgraded phone, or one that took the escape hatch and signed in later:
  // its records are already here, and holding it would only stop new photos.
  it("never holds a library that has imported before", () => {
    expect(importGateOf({ ...FRESH, imported: true })).toBe("open");
    expect(importGateOf({ ...FRESH, imported: true, hasCloud: true })).toBe("open");
  });
});

function rawDb(): RawDatabase {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        run: (...p: unknown[]) => stmt.run(...(p as never[])),
        get: (...p: unknown[]) => stmt.get(...(p as never[])),
        all: (...p: unknown[]) => stmt.all(...(p as never[])),
      };
    },
  };
}

describe("createImportGateStore", () => {
  it("starts with neither fact, and keeps each once recorded", () => {
    const db = rawDb();
    // The Drive channel's store creates the table, as it does in the node.
    createSqliteSyncStateStore({ db });
    const store = createImportGateStore(db);
    expect([store.drivePulled(), store.importWithoutPull()]).toEqual([false, false]);

    store.markDrivePulled();
    store.chooseImportWithoutPull();

    const reopened = createImportGateStore(db);
    expect([reopened.drivePulled(), reopened.importWithoutPull()]).toEqual([true, true]);
  });
});

function fakeOpSqlite() {
  const db = new DatabaseSync(":memory:");
  const connection: OpSqliteConnection = {
    executeSync(query: string, params?: unknown[]) {
      const stmt = db.prepare(query);
      if (/^\s*(select|pragma|with)/i.test(query)) {
        return { rows: stmt.all(...((params ?? []) as never[])) as unknown[] };
      }
      stmt.run(...((params ?? []) as never[]));
      return { rows: [] };
    },
    close() {
      db.close();
    },
  };
  return { open: () => connection };
}

let node: MobileNode | null = null;

afterEach(async () => {
  await node?.close();
  node = null;
});

/** Cloud storage that holds every file and serves none of them. */
class UnreadableStorage extends MockObjectStorageAdapter {
  override async getStream(): Promise<ReadableStream<Uint8Array> | null> {
    return null;
  }
}

let cloudDb: MockDatabaseAdapter;
const RECORD_ID = "rec-1" as StarkeepId;

/** A cloud record the phone wants the file of, with its bytes in `storage`. */
async function seedCloud(storage: MockObjectStorageAdapter): Promise<DataRecord> {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const at = { wallTime: Date.UTC(2026, 0, 1), counter: 1, nodeId: "cloud" };
  const record = {
    id: RECORD_ID,
    type: "image/jpeg",
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    version: 1,
    contentHash: hash,
    objectStorageKey: `shared/image/${hash.slice(0, 2)}/${hash}`,
    mimeType: "image/jpeg",
    sizeBytes: bytes.byteLength,
    originAppId: "photos",
    parentId: null,
    originalFilename: "photo-1.jpg",
    // Small enough to stand in for itself and within the phone's ceiling, so
    // residency wants the file.
    fidelity: 1000,
  } as DataRecord;
  await cloudDb.put(record);
  await storage.put(record.objectStorageKey!, bytes);
  return record;
}

async function openNode(
  withCloud: boolean,
  cloudStorage: MockObjectStorageAdapter = new MockObjectStorageAdapter(),
  seed?: (storage: MockObjectStorageAdapter) => Promise<unknown>,
): Promise<MobileNode> {
  cloudDb = new MockDatabaseAdapter();
  await cloudDb.init();
  await cloudStorage.init();
  await seed?.(cloudStorage);
  node = await createMobileNode({
    nodeId: "phone-a",
    databasePath: "/data/starkeep/local.sqlite",
    sqliteDriver: createOpSqliteDriver(fakeOpSqlite()),
    localObjectStorage: new ExpoObjectStorageAdapter({ fs: fakeExpoFs().fs, basePath: "/docs/objects" }),
    ...(withCloud
      ? {
          cloud: {
            remoteObjectStorage: cloudStorage,
            transport: createInProcessSyncTransport({
              databaseAdapter: cloudDb,
              clock: createHLCClock({ nodeId: "cloud" }),
              objectStorage: cloudStorage,
            }),
            readSyncUser: async () => ({ userId: "8f1c2d3e-0000-4000-8000-0000000000aa" }),
            readDeploymentSettings: async () => null,
          },
        }
      : {}),
  });
  return node;
}

describe("the node's import gate", () => {
  it("holds a signed-in fresh library until the cloud's rows arrive", async () => {
    const phone = await openNode(true, new MockObjectStorageAdapter(), seedCloud);
    expect(phone.importGate()).toBe("first-pull");

    const result = await phone.sync();

    expect(result?.complete).toBe(true);
    expect(await phone.databaseAdapter.get(RECORD_ID)).not.toBeNull();
    expect(phone.importGate()).toBe("open");
  });

  // The gate needs the rows, not the files. Rows apply before files download,
  // and a file that fails holds only the bytes watermark.
  it("opens even when a file will not download", async () => {
    const phone = await openNode(true, new UnreadableStorage(), seedCloud);

    const result = await phone.sync();

    expect(result?.complete).toBe(false);
    expect(await phone.databaseAdapter.get(RECORD_ID)).not.toBeNull();
    expect(phone.importGate()).toBe("open");
  });

  it("opens on a single round that drains the rows", async () => {
    const phone = await openNode(true, new UnreadableStorage(), seedCloud);

    const round = (await phone.exchange()) as { readonly hasMore: boolean } | null;

    expect(round?.hasMore).toBe(false);
    expect(phone.importGate()).toBe("open");
  });

  it("offers sign-in to a fresh library with no cloud, and opens on the escape hatch", async () => {
    const phone = await openNode(false);
    expect(phone.importGate()).toBe("sign-in");

    phone.importWithoutPull();

    expect(phone.importGate()).toBe("open");
  });
});
