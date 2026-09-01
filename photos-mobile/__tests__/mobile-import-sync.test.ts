/**
 * An imported camera-roll photo, syncing — the whole chain, assembled.
 *
 * The unit tests either side of this establish that the alias table stores what
 * it should and that the overlay adapter reads a `content://` asset. Neither can
 * answer the question the design actually rests on: **does the sync engine
 * accept an aliased original as a blob this node holds, with no change to the
 * engine at all?**
 *
 * That claim is the reason `import-loop-design.md` §2 is a paragraph rather than
 * a project. `residencyOf` derives residency from `localStorage.has(key)`, so
 * an alias that answers `has()` should be `resident` through the ordinary path
 * and push like anything else. If that were wrong, the alternative is teaching
 * the engine what a camera roll is — which is the fork the whole mobile
 * assembly exists to avoid.
 *
 * So this test imports a photo that exists *only* in the fake media store, runs
 * a real exchange against a peer, and asserts the bytes arrive. Nothing is
 * copied on the phone at any point, and that is asserted too.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createHLCClock } from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createInProcessSyncTransport } from "@starkeep/sync-engine";
import { createMobileNode, type MobileNode } from "../src/node";
import { createOpSqliteDriver, type OpSqliteConnection } from "../src/db/op-sqlite-driver";
import { ExpoObjectStorageAdapter } from "../src/storage/expo-object-storage";
import { importDeviceMedia, type HashBytes } from "../src/media/import";
import type {
  AssetMetadataLike,
  DeviceMediaModule,
  MediaQuery,
} from "../src/media/device-library";
import { fakeExpoFs } from "./helpers/fake-expo-fs";

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

const nodeHash: HashBytes = async (bytes) => createHash("sha256").update(bytes).digest("hex");

const PHOTO_URI = "content://media/external/images/media/1";
const PHOTO = new Uint8Array(Array.from({ length: 4096 }, (_, i) => i % 256));

function fakeMedia(rows: AssetMetadataLike[]): DeviceMediaModule {
  const query = (): MediaQuery => ({
    orderBy: () => query(),
    limit: () => query(),
    gte: () => query(),
    within: () => query(),
    exeForMetadata: async () => rows,
  });
  return {
    getPermissions: async () => ({ granted: true, canAskAgain: true }),
    requestPermissions: async () => ({ granted: true, canAskAgain: true }),
    newQuery: query,
    uriFor: async (id) => id,
  };
}

let phone: MobileNode;
let harness: ReturnType<typeof fakeExpoFs>;
let cloudDb: MockDatabaseAdapter;
let cloudStorage: MockObjectStorageAdapter;

beforeEach(async () => {
  cloudDb = new MockDatabaseAdapter();
  cloudStorage = new MockObjectStorageAdapter();
  await cloudDb.init();
  await cloudStorage.init();

  harness = fakeExpoFs();
  // The photo exists only in the "media store" — never in object storage.
  const file = harness.fs.file(PHOTO_URI);
  file.create({ intermediates: true, overwrite: true });
  file.write(PHOTO);

  phone = await createMobileNode({
    nodeId: "phone-a",
    databasePath: "/data/starkeep/local.sqlite",
    sqliteDriver: createOpSqliteDriver(fakeOpSqlite()),
    localObjectStorage: new ExpoObjectStorageAdapter({
      fs: harness.fs,
      basePath: "/docs/objects",
    }),
    cloud: {
      remoteObjectStorage: cloudStorage,
      transport: createInProcessSyncTransport({
        databaseAdapter: cloudDb,
        clock: createHLCClock({ nodeId: "cloud" }),
        objectStorage: cloudStorage,
      }),
    },
    deviceMedia: { fs: harness.fs },
  });
});

afterEach(async () => {
  await phone.close();
});

async function importThePhoto() {
  return importDeviceMedia(
    {
      media: fakeMedia([
        {
          id: PHOTO_URI,
          filename: "IMG_0001.jpg",
          mediaType: "image",
          width: 4032,
          height: 3024,
          duration: null,
          creationTime: 1_700_000_000_000,
          modificationTime: 1_700_000_000_000,
        },
      ]),
      aliases: phone.mediaAliases!,
      database: phone.databaseAdapter,
      clock: createHLCClock({ nodeId: "phone-a" }),
      fs: harness.fs,
      hash: nodeHash,
      yieldToUi: () => Promise.resolve(),
    },
    { limit: 10 },
  );
}

describe("a node that reads the camera roll", () => {
  it("exposes an alias store, where a plain node does not", () => {
    expect(phone.mediaAliases).not.toBeNull();
  });

  it("counts an imported photo as a blob it holds, with nothing in object storage", async () => {
    const { records } = await importThePhoto();
    const key = records[0]!.objectStorageKey!;

    // This is the assertion the design rests on. `has()` is what `residencyOf`
    // calls, and it says yes for bytes this node never wrote.
    expect(await phone.objectStorage.has(key)).toBe(true);
    expect(harness.fs.directory("/docs/objects").list()).toHaveLength(0);
  });
});

describe("an imported photo syncs", () => {
  it("pushes the record and its bytes to the peer", async () => {
    const { records } = await importThePhoto();
    const record = records[0]!;

    await phone.exchange();

    const remote = await cloudDb.get(record.id);
    expect(remote).not.toBeNull();
    expect(remote!.contentHash).toBe(record.contentHash);

    // The bytes came off the camera roll and went to the peer without ever
    // being written to the phone's own object store.
    expect(await cloudStorage.has(record.objectStorageKey!)).toBe(true);
    // Normalised to a plain Uint8Array: the mock stores a Buffer, and comparing
    // the two directly fails on the type tag while every byte agrees.
    const uploaded = await cloudStorage.get(record.objectStorageKey!);
    expect(new Uint8Array(uploaded!.data)).toEqual(PHOTO);
  });

  it("still holds nothing of its own after the push", async () => {
    // The phone gave the peer a durable copy and kept its side unchanged: the
    // camera roll is still the only local copy, which is what makes this cost
    // zero device storage.
    await importThePhoto();
    await phone.exchange();

    expect([...harness.files.keys()]).toEqual([PHOTO_URI]);
  });
});
