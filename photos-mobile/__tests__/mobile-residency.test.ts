/**
 * A phone whose ceiling actually binds.
 *
 * This is what the media plan says Phase 2 exists to validate: "the phone peer
 * is the only honest consumer of `Elided`". Here the library holds originals
 * above the phone's ceiling, and the node has to decline those bytes and still
 * be correct.
 *
 * `Elided` means: the record is present and its bytes are not. That is a valid,
 * intended state — not a failure — and the assertions below are careful to
 * distinguish it from "the sync did not work", which looks identical if you only
 * check one of the two.
 *
 * The declined fixtures are photographs above the phone's 1280-pixel ceiling,
 * whose stand-ins would take their place. The kept fixtures are PDFs, which no
 * stand-in can replace.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createHLCClock } from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createInProcessSyncTransport } from "@starkeep/sync-engine";
import { createMobileNode, type MobileNode } from "../src/node";
import { listLibrary } from "../src/library";
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

let cloudDb: MockDatabaseAdapter;
let cloudStorage: MockObjectStorageAdapter;
let phone: MobileNode | null = null;

/** Bytes of a stated size, and the hash that actually matches them. */
const bytesOf = (size: number, fill: number) => new Uint8Array(size).fill(fill);
const hashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let seq = 0;
async function seedCloud(sizeBytes: number): Promise<DataRecord> {
  return seedCloudFile(sizeBytes, "document/pdf", null);
}

/** An original above every phone's ceiling: a stand-in would take its place. */
async function seedCloudPhoto(sizeBytes: number): Promise<DataRecord> {
  return seedCloudFile(sizeBytes, "image/jpeg", 6000);
}

async function seedCloudFile(
  sizeBytes: number,
  type: string,
  fidelity: number | null,
): Promise<DataRecord> {
  seq += 1;
  const bytes = bytesOf(sizeBytes, seq % 251);
  const hash = hashOf(bytes);
  const rec = {
    id: `rec-${seq}`,
    type,
    fidelity,
    createdAt: { wallTime: Date.UTC(2026, 0, 1), counter: seq, nodeId: "cloud" },
    updatedAt: { wallTime: Date.UTC(2026, 0, 1), counter: seq, nodeId: "cloud" },
    deletedAt: null,
    version: 1,
    contentHash: hash,
    objectStorageKey: `shared/${type.split("/")[0]}/${hash.slice(0, 2)}/${hash}`,
    mimeType: null,
    sizeBytes,
    originAppId: "photos",
    parentId: null,
    originalFilename: `file-${seq}`,
  } as DataRecord;
  await cloudDb.put(rec);
  await cloudStorage.put(rec.objectStorageKey!, bytes);
  return rec;
}

async function startPhone(): Promise<MobileNode> {
  const harness = fakeExpoFs();
  return createMobileNode({
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
  });
}

/** Everything the phone knows about, and whether it holds the bytes. */
async function residencyOf(node: MobileNode) {
  const { records } = await node.databaseAdapter.query({});
  // `DataRecord["id"]` rather than `string`: record ids are branded, and a
  // helper that widens them hands back something the adapter will not accept
  // on the way in again.
  const held: DataRecord["id"][] = [];
  const elided: DataRecord["id"][] = [];
  for (const r of records) {
    if (!r.objectStorageKey) continue;
    ((await node.objectStorage.has(r.objectStorageKey)) ? held : elided).push(r.id);
  }
  return { total: records.length, held, elided };
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

const KB = 1024;

describe("a ceiling that binds", () => {
  it("keeps the records and declines the originals above the ceiling", async () => {
    for (let i = 0; i < 3; i += 1) await seedCloudPhoto(10 * KB);
    for (let i = 0; i < 2; i += 1) await seedCloud(10 * KB);
    phone = await startPhone();
    await phone.sync();

    const state = await residencyOf(phone);
    // Metadata is cheap and always syncs — a phone that dropped records would
    // be unable to *show* the library, not merely unable to open a photo.
    expect(state.total, "records must sync regardless of the ceiling").toBe(5);
    expect(state.elided, "the originals above the ceiling").toHaveLength(3);
    // The opposite failure: a node that declines everything is as broken as
    // one that declines nothing, and both satisfy "some records have no bytes".
    expect(state.held, "the documents, which no stand-in replaces").toHaveLength(2);
  });
});

/**
 * The way back from a decline, reached the way a person reaches it.
 *
 * Eliding **advances the watermark** — that is what makes declining a blob a
 * terminal state rather than a permanent retry — so the cloud considers the
 * record delivered and no number of sync rounds will ever offer those bytes
 * again. An explicit fetch is the only route back, and until now it had no
 * caller anywhere in either repo: the phone rendered a placeholder tile and
 * there was no code path that could ever turn it into a photo.
 *
 * These go through `MobileNode.fetchBlob` — what the tile's button calls —
 * rather than through the file-sync engine directly, because the thing that was
 * missing was the wiring, not the transfer.
 */
describe("fetching back a declined photo", () => {
  it("brings down bytes no sync round would ever offer again", async () => {
    const record = await seedCloudPhoto(10 * KB);
    phone = await startPhone();
    await phone.sync();

    // Declined, and the cloud believes it landed.
    expect(await phone.objectStorage.has(record.objectStorageKey!)).toBe(false);
    const again = await phone.sync();
    expect(again!.applied).toBe(0);
    expect(await phone.objectStorage.has(record.objectStorageKey!)).toBe(false);

    const held = (await phone.databaseAdapter.get(record.id))!;
    expect(await phone.fetchBlob(held)).toBe(true);
    expect(await phone.objectStorage.has(record.objectStorageKey!)).toBe(true);
  });

  it("makes the record openable, which is the point of fetching it", async () => {
    // The user-visible half. A fetch that lands bytes nothing can name is a
    // fetch that changed nothing anyone can see.
    //
    // Asserted on `bytesHere` rather than on `uri`, because the list stopped
    // painting originals: fetching an original back gives the viewer a
    // photograph and gives the tile nothing, which is the intended shape. `uri`
    // moves here only for a fetched *rendition*, and this case fetches the
    // original.
    const record = await seedCloudPhoto(10 * KB);
    phone = await startPhone();
    await phone.sync();

    const deps = {
      database: phone.databaseAdapter,
      objectStorage: phone.objectStorage,
      aliases: phone.mediaAliases,
    };
    const before = await listLibrary(deps, { limit: 10 });
    expect(before.items[0]!.bytesHere, "an elided record has no bytes yet").toBe(false);
    expect(before.items[0]!.uri).toBeNull();

    await phone.fetchBlob((await phone.databaseAdapter.get(record.id))!);

    const after = await listLibrary(deps, { limit: 10 });
    expect(after.items[0]!.bytesHere).toBe(true);
  });

  it("says no, rather than throwing, on a phone with no cloud", async () => {
    // The ordinary state of a handset nobody has signed in on. A button that
    // threw here would have to be hidden behind a session check the rest of
    // this app spent two revisions removing.
    const harness = fakeExpoFs();
    phone = await createMobileNode({
      nodeId: "phone-offline",
      databasePath: "/data/starkeep/local.sqlite",
      sqliteDriver: createOpSqliteDriver(fakeOpSqlite()),
      localObjectStorage: new ExpoObjectStorageAdapter({
        fs: harness.fs,
        basePath: "/docs/objects",
      }),
    });
    const record = await seedCloud(10 * KB);
    expect(await phone.fetchBlob(record)).toBe(false);
  });

  it("does not record an arrival when the fetch fails", async () => {
    // The same rule a round's pull obeys: recording a decision rather than an
    // arrival lets a node believe it holds files it does not.
    const record = await seedCloudPhoto(10 * KB);
    phone = await startPhone();
    await phone.sync();

    await cloudStorage.delete(record.objectStorageKey!);
    const held = (await phone.databaseAdapter.get(record.id))!;
    expect(await phone.fetchBlob(held)).toBe(false);
    expect(phone.residency.usageByGroup()).toEqual({});
  });
});

/**
 * The acquisition queue on the device it exists for.
 *
 * The core suite proves the ordering and the bound. What this covers is the
 * hookup: that the phone actually writes a queue during a round, actually
 * sweeps its catalogue for what no round will offer again, and actually drains
 * the queue afterwards. `CLAUDE.md` is explicit that a module nobody calls
 * creates the impression that more has been done than has been.
 */
describe("acquiring what a round did not bring", () => {
  it("finds bytes that went away, which no round will ever offer again", async () => {
    for (let i = 0; i < 3; i += 1) await seedCloud(10 * KB);
    phone = await startPhone();
    await phone.sync();

    const { held } = await residencyOf(phone);
    const record = (await phone.databaseAdapter.get(held[0]!))!;
    const key = record.objectStorageKey!;
    await phone.objectStorage.delete(key);
    phone.residency.noteDeparture(key);

    // The watermark moved past this record long ago, so the sweep is the only
    // thing that can find it.
    const scan = await phone.scanForAcquirable();
    expect(scan.complete).toBe(true);
    expect(phone.residency.deferredCandidates(100).map((e) => e.objectStorageKey)).toContain(key);

    await phone.acquireQueued();
    expect(await phone.objectStorage.has(key)).toBe(true);
  });

  it("resumes a sweep it was killed part-way through", async () => {
    for (let i = 0; i < 6; i += 1) await seedCloud(10 * KB);
    phone = await startPhone();
    await phone.sync();

    const first = await phone.scanForAcquirable({ maxRecords: 2 });
    expect(first.complete).toBe(false);
    // The cursor is on disk, so the next window carries on rather than starting
    // the library again — which on a real library is the difference between a
    // sweep that finishes and one that never does.
    const second = await phone.scanForAcquirable({ maxRecords: 100 });
    expect(second.complete).toBe(true);
  });

  it("has nothing to fetch when the phone already holds what it wants", async () => {
    for (let i = 0; i < 3; i += 1) await seedCloud(10 * KB);
    await seedCloudPhoto(10 * KB);
    phone = await startPhone();
    await phone.sync();

    expect(await phone.scanForAcquirable()).toEqual({ queued: 0, complete: true });
    expect(await phone.acquireQueued()).toEqual({ landed: 0, bytesLanded: 0, dropped: 0, failed: 0 });
  });
});
