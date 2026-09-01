/**
 * A node with no cloud — which is what every handset is today, and what the
 * app's own copy has claimed all along is a supported way to run.
 *
 * Until now the type said otherwise: `transport` and `remoteObjectStorage` were
 * required, so no node existed without a cloud to talk to. That is the sign-in
 * gate this app removed twice, re-appearing as a signature. These tests pin the
 * corrected shape — a node that imports, indexes and answers questions with
 * nothing to exchange with, and says so rather than pretending.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createHLCClock } from "@starkeep/protocol-primitives";
import { createMobileNode, type MobileNode } from "../src/node";
import { createOpSqliteDriver, type OpSqliteConnection } from "../src/db/op-sqlite-driver";
import { ExpoObjectStorageAdapter } from "../src/storage/expo-object-storage";
import { importDeviceMedia, type HashBytes } from "../src/media/import";
import { listLibrary, summarizeLibrary } from "../src/library";
import type { AssetMetadataLike, DeviceMediaModule, MediaQuery } from "../src/media/device-library";
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

function assetAt(uri: string, created: number): AssetMetadataLike {
  return {
    id: uri,
    filename: `IMG_${created}.jpg`,
    mediaType: "image",
    width: 4032,
    height: 3024,
    duration: null,
    creationTime: created,
    modificationTime: created,
  };
}

let phone: MobileNode;
let harness: ReturnType<typeof fakeExpoFs>;

const URI_A = "content://media/external/images/media/1";
const URI_B = "content://media/external/images/media/2";

beforeEach(async () => {
  harness = fakeExpoFs();
  for (const [uri, fill] of [
    [URI_A, 1],
    [URI_B, 2],
  ] as const) {
    const file = harness.fs.file(uri);
    file.create({ intermediates: true, overwrite: true });
    file.write(new Uint8Array(Array.from({ length: 512 }, (_, i) => (i + fill) % 256)));
  }

  phone = await createMobileNode({
    nodeId: "phone-a",
    databasePath: "/data/starkeep/local.sqlite",
    sqliteDriver: createOpSqliteDriver(fakeOpSqlite()),
    localObjectStorage: new ExpoObjectStorageAdapter({ fs: harness.fs, basePath: "/docs/objects" }),
    deviceMedia: { fs: harness.fs },
    // No `cloud`. That is the whole point.
  });
});

afterEach(async () => {
  await phone.close();
});

async function importBoth() {
  return importDeviceMedia(
    {
      media: fakeMedia([assetAt(URI_B, 2_000), assetAt(URI_A, 1_000)]),
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

describe("a node built with no cloud", () => {
  it("comes up, with no sync engine", () => {
    expect(phone.engine).toBeNull();
    // Everything that is not sync is present and usable.
    expect(phone.databaseAdapter).toBeDefined();
    expect(phone.mediaAliases).not.toBeNull();
  });

  it("treats exchange() as a no-op rather than throwing", async () => {
    // A job scheduler should not have to know whether this device has ever been
    // signed in, and an exception on the ordinary offline path is how a queue
    // learns to swallow exceptions.
    await expect(phone.exchange()).resolves.toBeNull();
  });

  it("imports the camera roll with no cloud in sight", async () => {
    const outcome = await importBoth();
    expect(outcome.imported).toBe(2);
    expect(outcome.failed).toBe(0);
  });

  it("holds the imported bytes without copying them", async () => {
    const { records } = await importBoth();
    for (const record of records) {
      expect(await phone.objectStorage.has(record.objectStorageKey!)).toBe(true);
    }
    expect([...harness.files.keys()].sort()).toEqual([URI_A, URI_B]);
  });
});

describe("the library the UI reads", () => {
  it("lists imported records newest first", async () => {
    await importBoth();
    const deps = { database: phone.databaseAdapter, objectStorage: phone.objectStorage, aliases: phone.mediaAliases };

    const page = await listLibrary(deps, { limit: 10 });

    expect(page.items).toHaveLength(2);
    // Newest first: a library opening on the oldest photo reads as the wrong
    // library rather than the wrong sort order.
    const created = page.items.map((i) => i.record.createdAt.wallTime);
    expect(created[0]).toBeGreaterThanOrEqual(created[1]!);
  });

  it("gives every item a URI an Image can render", async () => {
    await importBoth();
    const deps = { database: phone.databaseAdapter, objectStorage: phone.objectStorage, aliases: phone.mediaAliases };

    const page = await listLibrary(deps, { limit: 10 });

    // This is what makes a tile show a picture: the alias resolves the record
    // straight back to the camera-roll asset holding its bytes.
    expect(page.items.map((i) => i.uri).sort()).toEqual([URI_A, URI_B]);
  });

  it("reports no URI for a record whose bytes are not on this device", async () => {
    const { records } = await importBoth();
    // Drop the alias, as a stale one would be dropped: the record survives, its
    // bytes do not. A placeholder tile, not an error.
    phone.mediaAliases!.remove(records[0]!.objectStorageKey!);

    const page = await listLibrary(
      { database: phone.databaseAdapter, objectStorage: phone.objectStorage, aliases: phone.mediaAliases },
      { limit: 10 },
    );

    expect(page.items.filter((i) => i.uri === null)).toHaveLength(1);
  });

  it("summarises what the node holds and what the media store holds for it", async () => {
    await importBoth();

    const summary = await summarizeLibrary({
      database: phone.databaseAdapter,
      objectStorage: phone.objectStorage,
      aliases: phone.mediaAliases,
    });

    expect(summary.records).toBe(2);
    expect(summary.aliasedBytes).toBe(1024);
  });

  it("summarises an empty node as empty rather than failing", async () => {
    const summary = await summarizeLibrary({
      database: phone.databaseAdapter,
      objectStorage: phone.objectStorage,
      aliases: phone.mediaAliases,
    });
    expect(summary).toEqual({ records: 0, aliasedBytes: 0 });
  });
});
