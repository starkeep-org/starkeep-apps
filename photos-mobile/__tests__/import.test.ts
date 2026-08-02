/**
 * The import loop (`import-loop-design.md` §1–2).
 *
 * What this is really testing is a claim about *absence*: that importing a
 * 3 MB photo writes a record, writes an alias, and writes no bytes anywhere.
 * That is the whole design, and it is the kind of property that is easy to
 * satisfy on day one and easy to lose later to a well-meaning `put()`.
 *
 * The other half is the crash window. A phone is killed whenever the OS likes,
 * including between the alias write and the record write, and the recovery
 * behaviour is asserted here rather than reasoned about — it is not otherwise
 * observable until it happens on someone's handset.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createHLCClock, dataRecordObjectKey } from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, type RawDatabase } from "@starkeep/storage-adapter";
import { createSqliteMediaAliasStore, type MediaAliasStore } from "../src/media/media-alias";
import { importDeviceMedia, type HashFactory } from "../src/media/import";
import type {
  AssetMetadataLike,
  DeviceMediaModule,
  MediaQuery,
} from "../src/media/device-library";
import { fakeExpoFs } from "./helpers/fake-expo-fs";

/** node:crypto standing in for the phone's js-sha256 — same digest either way. */
const nodeHash: HashFactory = () => {
  const h = createHash("sha256");
  return { update: (c) => void h.update(c), digestHex: () => h.digest("hex") };
};

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

function asset(overrides: Partial<AssetMetadataLike> & { id: string }): AssetMetadataLike {
  return {
    filename: "IMG_0001.jpg",
    mediaType: "image",
    width: 4032,
    height: 3024,
    duration: null,
    creationTime: 1_700_000_000_000,
    modificationTime: 1_700_000_000_000,
    ...overrides,
  };
}

/** A media store whose asset ids are already `content://` URIs, as Android's are. */
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

let fs: ReturnType<typeof fakeExpoFs>;
let aliases: MediaAliasStore;
let database: MockDatabaseAdapter;

const URI_1 = "content://media/external/images/media/1";
const PHOTO = new Uint8Array(Array.from({ length: 3000 }, (_, i) => i % 256));

function putAsset(uri: string, bytes: Uint8Array): void {
  const file = fs.fs.file(uri);
  file.create({ intermediates: true, overwrite: true });
  file.write(bytes);
}

function deps() {
  return {
    media: fakeMedia([asset({ id: URI_1 })]),
    aliases,
    database,
    clock: createHLCClock({ nodeId: "phone" }),
    fs: fs.fs,
    hash: nodeHash,
    now: () => 1_700_000_500_000,
  };
}

beforeEach(async () => {
  fs = fakeExpoFs();
  aliases = createSqliteMediaAliasStore({ db: rawDb() });
  database = new MockDatabaseAdapter();
  await database.init();
  putAsset(URI_1, PHOTO);
});

describe("importDeviceMedia", () => {
  it("creates a record whose key is the content hash of the asset's bytes", async () => {
    const outcome = await importDeviceMedia(deps(), { limit: 10 });

    expect(outcome.imported).toBe(1);
    const record = outcome.records[0]!;
    const expected = createHash("sha256").update(PHOTO).digest("hex");
    expect(record.contentHash).toBe(expected);
    expect(record.objectStorageKey).toBe(dataRecordObjectKey("image/jpeg", expected));
    expect(record.sizeBytes).toBe(PHOTO.byteLength);
    expect(record.originalFilename).toBe("IMG_0001.jpg");
    expect(record.originAppId).toBe("photos");
  });

  it("writes no bytes anywhere — which is the entire point", async () => {
    const before = [...fs.files.keys()];
    expect(before).toEqual([URI_1]);

    await importDeviceMedia(deps(), { limit: 10 });

    // Asserted over the filesystem's actual contents rather than a counter: the
    // claim is that a 3 MB photo became a record and an alias and *no new
    // file*, and the only way to be sure is to look at every file there is.
    expect([...fs.files.keys()]).toEqual([URI_1]);
    expect(fs.files.get(URI_1)).toEqual(PHOTO);
  });

  it("aliases the record's blob to the asset that already holds it", async () => {
    const outcome = await importDeviceMedia(deps(), { limit: 10 });
    const record = outcome.records[0]!;

    const alias = aliases.get(record.objectStorageKey);
    expect(alias).toMatchObject({
      recordId: record.id,
      contentUri: URI_1,
      assetId: URI_1,
      sizeBytes: PHOTO.byteLength,
      modificationTimeMs: 1_700_000_000_000,
      addedAtMs: 1_700_000_500_000,
    });
  });

  it("stores the record, so the node actually holds it", async () => {
    const outcome = await importDeviceMedia(deps(), { limit: 10 });
    expect(await database.get(outcome.records[0]!.id)).not.toBeNull();
  });

  it("types a HEIC by its extension rather than the store's `image` category", async () => {
    // The distinction derivation ownership turns on: the cloud fallback cannot
    // decode HEIC, so a record typed `image/jpeg` because the media store said
    // "image" would be handed to a deriver that cannot read it.
    const d = { ...deps(), media: fakeMedia([asset({ id: URI_1, filename: "IMG_0002.HEIC" })]) };
    const outcome = await importDeviceMedia(d, { limit: 10 });
    expect(outcome.records[0]!.type).toBe("image/heic");
  });
});

describe("re-import", () => {
  it("skips an asset that is already imported and unchanged", async () => {
    await importDeviceMedia(deps(), { limit: 10 });
    const second = await importDeviceMedia(deps(), { limit: 10 });

    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("re-imports an asset edited in place", async () => {
    await importDeviceMedia(deps(), { limit: 10 });

    // Same asset id, new bytes, new mtime — the media store does this for an
    // in-place edit, and the old record's content hash now describes bytes that
    // no longer exist.
    putAsset(URI_1, new Uint8Array(500));
    const edited = {
      ...deps(),
      media: fakeMedia([asset({ id: URI_1, modificationTime: 1_700_009_999_000 })]),
    };
    const second = await importDeviceMedia(edited, { limit: 10 });

    expect(second.imported).toBe(1);
    expect(second.records[0]!.sizeBytes).toBe(500);
  });

  it("completes an import that was killed between the alias and the record", async () => {
    const first = await importDeviceMedia(deps(), { limit: 10 });
    const orphaned = first.records[0]!;

    // Simulate the crash window: the alias survived, the record did not.
    await database.delete(orphaned.id, orphaned.updatedAt);
    const fresh = new MockDatabaseAdapter();
    await fresh.init();

    const second = await importDeviceMedia({ ...deps(), database: fresh }, { limit: 10 });

    expect(second.imported).toBe(1);
    const recovered = second.records[0]!;
    // Same bytes, so the same content-addressed key — and the alias must now
    // point at the new record rather than the one that never made it to disk.
    expect(recovered.objectStorageKey).toBe(orphaned.objectStorageKey);
    expect(aliases.get(recovered.objectStorageKey)?.recordId).toBe(recovered.id);
  });
});

describe("assets that cannot be read", () => {
  it("counts an unreadable asset as failed without abandoning the rest", async () => {
    // The media store can hand back an id whose bytes are on an unmounted
    // volume. Losing 59,999 photos to one of them is not acceptable behaviour.
    const gone = "content://media/external/images/media/404";
    const d = {
      ...deps(),
      media: fakeMedia([asset({ id: gone }), asset({ id: URI_1 })]),
    };

    const outcome = await importDeviceMedia(d, { limit: 10 });

    expect(outcome.scanned).toBe(2);
    expect(outcome.imported).toBe(1);
    expect(outcome.failed).toBe(1);
  });
});
