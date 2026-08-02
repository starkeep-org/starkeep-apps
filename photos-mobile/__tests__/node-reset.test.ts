/**
 * Clearing the node's data.
 *
 * The assertion this file exists for is the one about *absence*: that a reset
 * deletes the index and leaves every photograph exactly where it was. The
 * design makes that cheap to guarantee — originals are aliased rather than
 * copied, so the node never held a photo to lose — but "cheap to guarantee" and
 * "guaranteed" are different, and this is a delete running against a filesystem
 * that also contains the user's camera roll.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createHLCClock } from "@starkeep/protocol-primitives";
import { createMobileNode, type MobileNode } from "../src/node";
import { createOpSqliteDriver, type OpSqliteConnection } from "../src/db/op-sqlite-driver";
import { ExpoObjectStorageAdapter } from "../src/storage/expo-object-storage";
import { importDeviceMedia, type HashBytes } from "../src/media/import";
import { clearNodeFiles } from "../src/node-reset";
import { listLibrary } from "../src/library";
import type { AssetMetadataLike, DeviceMediaModule, MediaQuery } from "../src/media/device-library";
import { fakeExpoFs } from "./helpers/fake-expo-fs";

const DB = "/docs/starkeep/local.sqlite";
const OBJECTS = "/docs/starkeep/objects";
const IDENTITY = "/docs/starkeep/node.json";
const SESSION = "/docs/starkeep/session.json";
const PHOTO_A = "content://media/external/images/media/1";
const PHOTO_B = "content://media/external/images/media/2";

const nodeHash: HashBytes = async (bytes) => createHash("sha256").update(bytes).digest("hex");

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

function fakeMedia(rows: AssetMetadataLike[]): DeviceMediaModule {
  const query = (): MediaQuery => ({
    orderBy: () => query(),
    limit: () => query(),
    exeForMetadata: async () => rows,
  });
  return {
    getPermissions: async () => ({ granted: true, canAskAgain: true }),
    requestPermissions: async () => ({ granted: true, canAskAgain: true }),
    newQuery: query,
    uriFor: async (id) => id,
  };
}

function assetAt(uri: string): AssetMetadataLike {
  return {
    id: uri,
    filename: "IMG.jpg",
    mediaType: "image",
    width: 100,
    height: 100,
    duration: null,
    creationTime: 1_700_000_000_000,
    modificationTime: 1_700_000_000_000,
  };
}

let fs: ReturnType<typeof fakeExpoFs>;
let node: MobileNode;

function write(path: string, bytes: Uint8Array): void {
  const file = fs.fs.file(path);
  file.create({ intermediates: true, overwrite: true });
  file.write(bytes);
}

beforeEach(async () => {
  fs = fakeExpoFs();
  write(PHOTO_A, new Uint8Array([1, 2, 3, 4]));
  write(PHOTO_B, new Uint8Array([5, 6, 7, 8]));
  // Things a reset must leave alone, alongside the ones it must remove.
  write(IDENTITY, new TextEncoder().encode(JSON.stringify({ nodeId: "phone-a" })));
  write(SESSION, new TextEncoder().encode(JSON.stringify({ refreshToken: "t" })));

  node = await createMobileNode({
    nodeId: "phone-a",
    databasePath: DB,
    sqliteDriver: createOpSqliteDriver(fakeOpSqlite()),
    localObjectStorage: new ExpoObjectStorageAdapter({ fs: fs.fs, basePath: OBJECTS }),
    deviceMedia: { fs: fs.fs },
  });

  await importDeviceMedia(
    {
      media: fakeMedia([assetAt(PHOTO_A), assetAt(PHOTO_B)]),
      aliases: node.mediaAliases!,
      database: node.databaseAdapter,
      clock: createHLCClock({ nodeId: "phone-a" }),
      fs: fs.fs,
      hash: nodeHash,
      yieldToUi: () => Promise.resolve(),
    },
    { limit: 10 },
  );
});

describe("clearNodeFiles", () => {
  it("does not touch a single photograph", async () => {
    // The assertion this whole file exists for.
    await node.close();
    clearNodeFiles(fs.fs, { databasePath: DB, objectsPath: OBJECTS });

    expect(fs.fs.file(PHOTO_A).exists).toBe(true);
    expect(fs.fs.file(PHOTO_B).exists).toBe(true);
    expect(Array.from(fs.files.get(PHOTO_A)!)).toEqual([1, 2, 3, 4]);
  });

  it("keeps the node's identity, which is not data", async () => {
    // Regenerating it would make this phone look like a brand new peer to
    // everyone it has ever synced with — see `node-identity.ts`.
    await node.close();
    clearNodeFiles(fs.fs, { databasePath: DB, objectsPath: OBJECTS });

    expect(fs.fs.file(IDENTITY).exists).toBe(true);
  });

  it("keeps the session, because signing out is a different action", async () => {
    await node.close();
    clearNodeFiles(fs.fs, { databasePath: DB, objectsPath: OBJECTS });

    expect(fs.fs.file(SESSION).exists).toBe(true);
  });

  it("deletes the database, its write-ahead log and its shared-memory file", async () => {
    // The `-wal` in particular: leaving it can resurrect rows the main file no
    // longer has, which reads as "clearing did not work".
    write(`${DB}-wal`, new Uint8Array([9]));
    write(`${DB}-shm`, new Uint8Array([9]));
    await node.close();

    clearNodeFiles(fs.fs, { databasePath: DB, objectsPath: OBJECTS });

    expect(fs.fs.file(DB).exists).toBe(false);
    expect(fs.fs.file(`${DB}-wal`).exists).toBe(false);
    expect(fs.fs.file(`${DB}-shm`).exists).toBe(false);
  });

  it("empties the object store, recursively", async () => {
    write(`${OBJECTS}/ab/abcd`, new Uint8Array([1]));
    write(`${OBJECTS}/cd/cdef`, new Uint8Array([2]));
    await node.close();

    clearNodeFiles(fs.fs, { databasePath: DB, objectsPath: OBJECTS });

    expect(fs.fs.file(`${OBJECTS}/ab/abcd`).exists).toBe(false);
    expect(fs.fs.file(`${OBJECTS}/cd/cdef`).exists).toBe(false);
    expect(fs.fs.directory(OBJECTS).exists).toBe(false);
  });

  it("leaves nothing behind but the camera roll and the two kept files", async () => {
    await node.close();
    clearNodeFiles(fs.fs, { databasePath: DB, objectsPath: OBJECTS });

    // Enumerated rather than spot-checked: a delete that took something not
    // listed here would pass every assertion above.
    expect([...fs.files.keys()].sort()).toEqual([PHOTO_A, PHOTO_B, IDENTITY, SESSION].sort());
  });

  it("is safe when there is nothing to clear", () => {
    // A reset on a device that has never imported, or a second reset.
    const empty = fakeExpoFs();
    expect(() =>
      clearNodeFiles(empty.fs, { databasePath: DB, objectsPath: OBJECTS }),
    ).not.toThrow();
  });
});

describe("the node after a reset", () => {
  it("comes back empty, and can import the same photos again", async () => {
    const before = await listLibrary(
      { database: node.databaseAdapter, aliases: node.mediaAliases },
      { limit: 10 },
    );
    expect(before.items).toHaveLength(2);

    await node.close();
    clearNodeFiles(fs.fs, { databasePath: DB, objectsPath: OBJECTS });

    const rebuilt = await createMobileNode({
      nodeId: "phone-a",
      databasePath: DB,
      sqliteDriver: createOpSqliteDriver(fakeOpSqlite()),
      localObjectStorage: new ExpoObjectStorageAdapter({ fs: fs.fs, basePath: OBJECTS }),
      deviceMedia: { fs: fs.fs },
    });

    const after = await listLibrary(
      { database: rebuilt.databaseAdapter, aliases: rebuilt.mediaAliases },
      { limit: 10 },
    );
    expect(after.items).toEqual([]);

    // And the point of clearing: the same assets import again from scratch,
    // which is what makes this useful for measuring a cold import.
    const second = await importDeviceMedia(
      {
        media: fakeMedia([assetAt(PHOTO_A), assetAt(PHOTO_B)]),
        aliases: rebuilt.mediaAliases!,
        database: rebuilt.databaseAdapter,
        clock: createHLCClock({ nodeId: "phone-a" }),
        fs: fs.fs,
        hash: nodeHash,
        yieldToUi: () => Promise.resolve(),
      },
      { limit: 10 },
    );
    expect(second.imported).toBe(2);
    expect(second.skipped).toBe(0);

    await rebuilt.close();
  });
});
