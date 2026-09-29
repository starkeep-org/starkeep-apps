/**
 * Residency on a phone, through `MobileNode` the way the app assembles one.
 *
 * A phone receives every file no stand-in can replace, and stand-ins up to its
 * ceiling. Nothing removes a file on its own; the person's "Free up space"
 * removes one only once the cloud is proved to hold it. Every case goes
 * through `MobileNode`, never through the manager directly, because the wiring
 * is what these cases check.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createDataRecord, createHLCClock } from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createInProcessSyncTransport } from "@starkeep/sync-engine";
import { createMobileNode, type MobileNode } from "../src/node";
import { PHOTOS_APP_ID } from "../src/photos/renditions";
import { createOpSqliteDriver, type OpSqliteConnection } from "../src/db/op-sqlite-driver";
import { ExpoObjectStorageAdapter } from "../src/storage/expo-object-storage";
import { fakeExpoFs } from "./helpers/fake-expo-fs";
import type { DataRecord } from "@starkeep/protocol-primitives";

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

const KB = 1024;

let cloudDb: MockDatabaseAdapter;
let cloudStorage: MockObjectStorageAdapter;
let phone: MobileNode | null = null;

const bytesOf = (size: number, fill: number) => new Uint8Array(size).fill(fill);
const hexOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const b64Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("base64");

let seq = 0;

/**
 * Seed the cloud with one file — a PDF unless told otherwise.
 *
 * `withChecksum` is the whole difference between a durable replica and a merely
 * present one. `assessDurability` counts `confirmed` — the store's own checksum
 * matching the record's content hash — and treats a present object with no
 * checksum as `present-unverified`, which by default counts as nothing. That is
 * not a detail of the fake: it is the stance the durability predicate takes on
 * purpose, and a test that always supplied a checksum would never exercise the
 * refusal.
 */
async function seedCloud(
  sizeBytes: number,
  options: {
    withChecksum?: boolean;
    type?: string;
    parentId?: string;
    standInRole?: "canonical" | "smaller";
    fidelity?: number;
  } = {},
): Promise<DataRecord> {
  seq += 1;
  const bytes = bytesOf(sizeBytes, seq % 251);
  const hash = hexOf(bytes);
  const type = options.type ?? "document/pdf";
  const rec = {
    id: `rec-${seq}`,
    type,
    createdAt: { wallTime: Date.UTC(2026, 0, 1), counter: seq, nodeId: "cloud" },
    updatedAt: { wallTime: Date.UTC(2026, 0, 1), counter: seq, nodeId: "cloud" },
    deletedAt: null,
    version: 1,
    contentHash: hash,
    objectStorageKey: `shared/${type.split("/")[0]}/${hash.slice(0, 2)}/${hash}`,
    mimeType: null,
    sizeBytes,
    originAppId: PHOTOS_APP_ID,
    parentId: options.parentId ?? null,
    originalFilename: `file-${seq}`,
    standInRole: options.standInRole ?? null,
    fidelity: options.fidelity ?? null,
  } as DataRecord;
  await cloudDb.put(rec);
  await cloudStorage.put(
    rec.objectStorageKey!,
    bytes,
    options.withChecksum === false ? undefined : { checksumSha256: b64Of(bytes) },
  );
  return rec;
}

let harness: ReturnType<typeof fakeExpoFs>;

async function startPhone(
  options: { cloud?: boolean; deviceMedia?: boolean } = {},
): Promise<MobileNode> {
  harness = fakeExpoFs();
  return createMobileNode({
    nodeId: "phone-a",
    databasePath: "/data/starkeep/local.sqlite",
    sqliteDriver: createOpSqliteDriver(fakeOpSqlite()),
    localObjectStorage: new ExpoObjectStorageAdapter({
      fs: harness.fs,
      basePath: "/docs/objects",
    }),
    ...(options.cloud === false
      ? {}
      : {
          cloud: {
            remoteObjectStorage: cloudStorage,
            transport: createInProcessSyncTransport({
              databaseAdapter: cloudDb,
              clock: createHLCClock({ nodeId: "cloud" }),
              objectStorage: cloudStorage,
            }),
          },
        }),
    ...(options.deviceMedia ? { deviceMedia: { fs: harness.fs } } : {}),
  });
}

beforeEach(async () => {
  seq = 0;
  cloudDb = new MockDatabaseAdapter();
  cloudStorage = new MockObjectStorageAdapter();
  await cloudDb.init();
  await cloudStorage.init();
});

afterEach(async () => {
  await phone?.close();
  phone = null;
});

describe("what no stand-in can replace", () => {
  // A document and a poster frame: no stand-in can take either one's place,
  // so a phone takes both whatever its ceiling, and "Free up space" never
  // offers either.
  it("arrives on the phone and stays there", async () => {
    const pdf = await seedCloud(200 * KB);
    const original = await seedCloud(2 * 1024 * KB, { type: "image/jpeg", fidelity: 6000 });
    const poster = await seedCloud(8 * KB, { type: "image/webp", parentId: original.id });
    phone = await startPhone();
    await phone.sync();

    expect(await phone.objectStorage.has(pdf.objectStorageKey!)).toBe(true);
    expect(await phone.objectStorage.has(poster.objectStorageKey!)).toBe(true);

    await phone.freeUpSpace({ bytes: Number.MAX_SAFE_INTEGER, scope: "originals-and-above-ceiling" });
    expect(await phone.objectStorage.has(pdf.objectStorageKey!)).toBe(true);
    expect(await phone.objectStorage.has(poster.objectStorageKey!)).toBe(true);
  });
});

describe("pins", () => {
  it("brings a pinned original above the ceiling to the phone", async () => {
    const original = await seedCloud(2 * 1024 * KB, { type: "image/jpeg", fidelity: 6000 });
    phone = await startPhone();
    await phone.sync();
    expect(await phone.objectStorage.has(original.objectStorageKey!)).toBe(false);

    phone.setPinned(original.id, true);
    await phone.scanForAcquirable();
    const outcome = await phone.acquireQueued();
    expect(outcome?.landed).toBe(1);
    expect(await phone.objectStorage.has(original.objectStorageKey!)).toBe(true);
  });

  it("reports what it was told, and forgets on release", async () => {
    phone = await startPhone();
    phone.setPinned("rec-1", true);
    expect(phone.isPinned("rec-1")).toBe(true);
    phone.setPinned("rec-1", false);
    expect(phone.isPinned("rec-1")).toBe(false);
  });

  // A pin is meaningful *before* the bytes arrive — pinning is how you ask for
  // something you do not have yet — which is why pins live in their own table
  // rather than on the resident-set row.
  it("can be set for a record whose bytes are not here", async () => {
    phone = await startPhone();
    expect(() => phone!.setPinned("never-seen", true)).not.toThrow();
    expect(phone.isPinned("never-seen")).toBe(true);
  });
});

describe("what the Storage section reads", () => {
  it("reports held bytes by kind of file", async () => {
    await seedCloud(10 * KB);
    const original = await seedCloud(2 * 1024 * KB, { type: "image/jpeg", fidelity: 6000 });
    await seedCloud(5 * KB, { type: "image/avif", parentId: original.id, standInRole: "smaller", fidelity: 1280 });
    phone = await startPhone();
    await phone.sync();

    expect(phone.storageReport()).toEqual({
      groups: { kept: 10 * KB, "stand-in:image": 5 * KB },
      heldBytes: 15 * KB,
    });
  });

  it("reports nothing held on a fresh phone", async () => {
    phone = await startPhone();
    expect(phone.storageReport()).toEqual({ groups: {}, heldBytes: 0 });
  });
});

describe("bytes that went missing locally", () => {
  // The index is a cache of a fact the filesystem also knows. Each full sweep
  // of the catalogue reconciles it first, so bytes deleted behind its back are
  // noticed, queued and fetched again.
  it("are fetched again by the next full sweep", async () => {
    const record = await seedCloud(10 * KB);
    phone = await startPhone();
    await phone.sync();
    expect(phone.storageReport().heldBytes).toBe(10 * KB);

    await phone.objectStorage.delete(record.objectStorageKey!);
    expect(phone.storageReport().heldBytes, "the index has not noticed yet").toBe(10 * KB);

    const scan = await phone.scanForAcquirable();
    expect(scan).toMatchObject({ queued: 1, complete: true });
    await phone.acquireQueued();
    expect(await phone.objectStorage.has(record.objectStorageKey!)).toBe(true);
    expect(phone.storageReport().heldBytes).toBe(10 * KB);
  });
});

describe("photographs, against the phone's ceiling", () => {
  /**
   * A photograph in the cloud with its canonical stand-in and one smaller one.
   * Past the 1 MiB archive floor, so the original is archivable and removing
   * it needs a proof of the canonical stand-in too.
   */
  const ORIGINAL_BYTES = 2 * 1024 * KB;
  async function cloudPhotograph(options: { canonicalChecksum?: boolean } = {}) {
    const original = await seedCloud(ORIGINAL_BYTES, { type: "image/jpeg", fidelity: 6000 });
    const canonical = await seedCloud(20 * KB, {
      type: "image/avif",
      parentId: original.id,
      standInRole: "canonical",
      fidelity: 4272,
      withChecksum: options.canonicalChecksum ?? true,
    });
    const medium = await seedCloud(5 * KB, {
      type: "image/avif",
      parentId: original.id,
      standInRole: "smaller",
      fidelity: 1280,
    });
    return { original, canonical, medium };
  }

  it("receives stand-ins up to 1280 and leaves the original and canonical stand-in in the cloud", async () => {
    const f = await cloudPhotograph();
    phone = await startPhone();
    await phone.sync();

    expect(await phone.objectStorage.has(f.medium.objectStorageKey!)).toBe(true);
    expect(await phone.objectStorage.has(f.canonical.objectStorageKey!)).toBe(false);
    expect(await phone.objectStorage.has(f.original.objectStorageKey!)).toBe(false);
  });

  describe("Free up space", () => {
    it("removes an opened original once the cloud holds it and its canonical stand-in", async () => {
      const f = await cloudPhotograph();
      phone = await startPhone();
      await phone.sync();
      await phone.fetchBlob((await phone.databaseAdapter.get(f.original.id))!);

      const report = await phone.freeUpSpace({ bytes: 1, scope: "originals" });

      expect(report?.removed.map((r) => r.recordId)).toEqual([f.original.id]);
      expect(report?.freedBytes).toBe(ORIGINAL_BYTES);
      expect(await phone.objectStorage.has(f.original.objectStorageKey!)).toBe(false);
      // The stand-ins the grid paints from stay.
      expect(await phone.objectStorage.has(f.medium.objectStorageKey!)).toBe(true);
    });

    it("keeps the original when the cloud's canonical stand-in cannot be confirmed", async () => {
      const f = await cloudPhotograph({ canonicalChecksum: false });
      phone = await startPhone();
      await phone.sync();
      await phone.fetchBlob((await phone.databaseAdapter.get(f.original.id))!);

      const report = await phone.freeUpSpace({ bytes: 1, scope: "originals" });

      expect(report?.removed).toEqual([]);
      expect(report?.refused).toMatchObject([{ recordId: f.original.id, reason: "not-durable" }]);
      expect(await phone.objectStorage.has(f.original.objectStorageKey!)).toBe(true);
    });

    it("never offers a photograph from this phone's own camera roll", async () => {
      // An alias answers `has()` without holding bytes: deleting its key would
      // drop the alias and free nothing. A fetched original beside it is the
      // control, and shows the pass would have removed an eligible file.
      const fetched = await cloudPhotograph();
      phone = await startPhone({ deviceMedia: true });
      await phone.sync();
      await phone.fetchBlob((await phone.databaseAdapter.get(fetched.original.id))!);

      const clock = createHLCClock({ nodeId: "phone-a" });
      const hash = "c".repeat(64);
      const own = createDataRecord(
        {
          type: "image/jpeg",
          originAppId: PHOTOS_APP_ID,
          contentHash: hash,
          objectStorageKey: `shared/image/cc/${hash}`,
          sizeBytes: 90 * KB,
          originalFilename: "IMG_1.jpg",
          fidelity: 6000,
        },
        clock,
      );
      await phone.databaseAdapter.put(own);
      const contentUri = "content://media/external/images/media/1";
      harness.files.set(contentUri, new Uint8Array(90 * KB));
      phone.mediaAliases!.add({
        objectStorageKey: own.objectStorageKey,
        recordId: own.id,
        contentUri,
        assetId: "1",
        sizeBytes: own.sizeBytes,
        contentType: null,
        modificationTimeMs: 1_700_000_000_000,
        addedAtMs: 1_700_000_000_000,
      });
      expect(await phone.objectStorage.has(own.objectStorageKey)).toBe(true);

      const report = await phone.freeUpSpace({ bytes: 10 * ORIGINAL_BYTES, scope: "originals" });

      expect(report?.removed.map((r) => r.recordId)).toEqual([fetched.original.id]);
      expect(report?.eligibleBytes).toBe(ORIGINAL_BYTES);
      expect(phone.mediaAliases!.get(own.objectStorageKey)).not.toBeNull();
    });
  });
});
