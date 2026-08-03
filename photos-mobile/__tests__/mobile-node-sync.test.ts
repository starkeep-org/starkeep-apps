/**
 * A real sync exchange carried by the phone's adapters (item 12).
 *
 * The adapters are unit-tested apart; what none of those tests can show is
 * whether the *engine* runs on them. This assembles the node exactly as the app
 * will — SQLite through the op-sqlite driver, object storage through
 * expo-file-system — and syncs it against a peer, so the question "can the phone
 * actually be a peer" gets an answer here rather than on a handset.
 *
 * The peer is in-process and its adapters are mocks. That is the right
 * asymmetry: the thing under test is the phone's side, and using a real cloud
 * would test AWS.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createHLCClock } from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createInProcessSyncTransport } from "@starkeep/sync-engine";
import { createMobileNode, MOBILE_MAX_BYTES, MOBILE_MAX_ITEMS, type MobileNode } from "../src/node";
import { describeVerify, verifyFoundProblem } from "../src/ui/verify-text";
import { createOpSqliteDriver, type OpSqliteConnection } from "../src/db/op-sqlite-driver";
import { ExpoObjectStorageAdapter } from "../src/storage/expo-object-storage";
import { fakeExpoFs } from "./helpers/fake-expo-fs";
import type { DataRecord } from "@starkeep/protocol-primitives";

/** op-sqlite's shape over a real SQLite engine — see op-sqlite-driver.test.ts. */
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

let phone: MobileNode;
let cloudDb: MockDatabaseAdapter;
let cloudStorage: MockObjectStorageAdapter;

/**
 * Bytes first, then the hash of those bytes.
 *
 * Not a detail: blob transfer verifies the stream against the record's
 * contentHash and aborts the write on a mismatch, so a fixture with an invented
 * hash does not merely look wrong — it fails every transfer, and reads as a
 * sync bug rather than as the fixture lying.
 */
let seq = 0;
const bytesFor = (n: number) => new Uint8Array([n, n + 1, n + 2, n + 3, n + 4, n + 5, n + 6, n + 7]);
const hashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const record = (over: Partial<DataRecord> = {}): DataRecord => {
  seq += 1;
  const hash = hashOf(bytesFor(seq));
  return {
    id: `rec-${seq}`,
    type: "image/jpeg",
    createdAt: { wallTime: Date.UTC(2026, 0, 1), counter: seq, nodeId: "cloud" },
    updatedAt: { wallTime: Date.UTC(2026, 0, 1), counter: seq, nodeId: "cloud" },
    deletedAt: null,
    version: 1,
    contentHash: hash,
    objectStorageKey: `shared/image/${hash.slice(0, 2)}/${hash}`,
    mimeType: "image/jpeg",
    sizeBytes: 8,
    originAppId: "photos",
    parentId: null,
    originalFilename: `photo-${seq}.jpg`,
    ...over,
  } as DataRecord;
};

beforeEach(async () => {
  seq = 0;
  cloudDb = new MockDatabaseAdapter();
  cloudStorage = new MockObjectStorageAdapter();
  await cloudDb.init();
  await cloudStorage.init();

  const harness = fakeExpoFs();
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
  });
});

afterEach(async () => {
  await phone.close();
});

/** Put a record and its bytes on the cloud side. */
async function seedCloud(count: number): Promise<DataRecord[]> {
  const records: DataRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const r = record();
    await cloudDb.put(r);
    await cloudStorage.put(r.objectStorageKey!, bytesFor(records.length + 1));
    records.push(r);
  }
  return records;
}

describe("the phone as a peer", () => {
  it("pulls a record the cloud has and it does not", async () => {
    const [seeded] = await seedCloud(1);
    await phone.exchange();
    const local = await phone.databaseAdapter.get(seeded!.id);
    expect(local).not.toBeNull();
    expect(local!.contentHash).toBe(seeded!.contentHash);
  });

  it("lands the bytes, not just the metadata", async () => {
    const [seeded] = await seedCloud(1);
    await phone.exchange();
    // The record existing without its bytes is `Elided`, which is a real and
    // valid state — so asserting the row alone would pass on a node that
    // fetched nothing.
    expect(await phone.objectStorage.has(seeded!.objectStorageKey!)).toBe(true);
  });

  it("pushes a record the phone has and the cloud does not", async () => {
    const bytes = bytesFor(99);
    const local = record({
      contentHash: hashOf(bytes),
      objectStorageKey: `shared/image/${hashOf(bytes).slice(0, 2)}/${hashOf(bytes)}`,
      createdAt: { wallTime: Date.UTC(2026, 0, 2), counter: 1, nodeId: "phone-a" },
      updatedAt: { wallTime: Date.UTC(2026, 0, 2), counter: 1, nodeId: "phone-a" },
    });
    await phone.databaseAdapter.put(local);
    await phone.objectStorage.put(local.objectStorageKey!, bytes);

    await phone.exchange();
    expect(await cloudDb.get(local.id)).not.toBeNull();
  });

  it("converges without duplicating when run twice", async () => {
    await seedCloud(3);
    await phone.exchange();
    await phone.exchange();
    const { records } = await phone.databaseAdapter.query({});
    expect(records).toHaveLength(3);
  });

  // Constraint 1 of the phase: no sync round may be assumed to complete. This
  // is the cheapest honest version of that — the OS killing the app mid-round
  // is what a device does, and an abandoned exchange must leave the node able to
  // finish later rather than stuck or duplicated.
  it("resumes after an exchange is abandoned partway", async () => {
    await seedCloud(5);
    // Abandon the first round without awaiting it, then run to completion.
    void phone.exchange();
    await new Promise((r) => setTimeout(r, 0));
    await phone.exchange();
    await phone.exchange();
    const { records } = await phone.databaseAdapter.query({});
    expect(records).toHaveLength(5);
    expect(new Set(records.map((r) => r.id)).size).toBe(5);
  });

  // Rounds are small on purpose: the OS decides when the app stops, and a round
  // that takes thirty seconds gets abandoned partway on a real handset over and
  // over, making progress impossible rather than merely slow. Bytes are the
  // budget that binds here, because this channel carries photos.
  it("bounds a round to a few photos' worth of bytes", async () => {
    expect(MOBILE_MAX_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("carries more records than fit in one round, across rounds", async () => {
    await seedCloud(MOBILE_MAX_ITEMS + 20);
    for (let i = 0; i < 5; i += 1) await phone.exchange();
    const { records } = await phone.databaseAdapter.query({});
    expect(records.length).toBe(MOBILE_MAX_ITEMS + 20);
  }, 60_000);

  // One tap must be one sync. A single round moves at most one round's budget,
  // so a first upload of a real library needs hundreds of them.
  it("sync() drains the backlog in one call", async () => {
    await seedCloud(MOBILE_MAX_ITEMS + 20);
    const result = await phone.sync();
    expect(result?.complete).toBe(true);
    const { records } = await phone.databaseAdapter.query({});
    expect(records.length).toBe(MOBILE_MAX_ITEMS + 20);
  }, 60_000);
});

describe("durability across a restart", () => {
  // A phone is killed constantly. The watermark and the records must be in the
  // same file for this to hold — a watermark newer than the records it
  // describes makes a record invisible to sync forever.
  it("keeps its records and does not re-pull them", async () => {
    await seedCloud(2);
    await phone.exchange();
    const before = (await phone.databaseAdapter.query({})).records.length;
    expect(before).toBe(2);

    // The in-memory SQLite cannot survive a real close, so this asserts the
    // weaker but still meaningful property: a second exchange after the first
    // has settled pulls nothing new.
    await phone.exchange();
    expect((await phone.databaseAdapter.query({})).records).toHaveLength(2);
  });
});

/**
 * What the phone tells a person about their backup.
 *
 * The sentence someone decides whether to wipe their phone on, so it has to be
 * true in both directions. A check that only asks "is the cloud missing
 * anything?" reports all-clear to a phone that has itself lost rows — which is
 * the case where being wrong costs the most.
 */
describe("describing an integrity check", () => {
  const base = { supported: true as const, localRows: 100, peerRows: 100 };

  it("reports both counts when everything agrees", () => {
    const text = describeVerify({ ...base, divergentBuckets: 0, missingLocally: 0 });
    expect(text).toContain("100 of 100 rows");
    expect(verifyFoundProblem({ ...base, divergentBuckets: 0, missingLocally: 0 })).toBe(false);
  });

  it("says so when the cloud is missing rows", () => {
    const result = { ...base, divergentBuckets: 2, missingLocally: 0 };
    expect(describeVerify(result)).toContain("The cloud is missing rows in 2 time ranges");
    expect(verifyFoundProblem(result)).toBe(true);
  });

  it("says so when this phone is the one missing rows", () => {
    // The direction a one-sided check cannot see.
    const result = { ...base, divergentBuckets: 0, missingLocally: 1 };
    expect(describeVerify(result)).toContain("this phone is missing rows in 1 time range");
    expect(verifyFoundProblem(result)).toBe(true);
  });

  it("reports both when both sides have holes", () => {
    const result = { ...base, divergentBuckets: 1, missingLocally: 1 };
    const text = describeVerify(result);
    expect(text).toContain("The cloud is missing rows");
    expect(text).toContain("this phone is missing rows");
  });

  it("does not call an unanswerable check clean", () => {
    const result = { supported: false, localRows: 0, peerRows: 0, divergentBuckets: 0, missingLocally: 0 };
    expect(describeVerify(result)).toContain("nothing was verified");
    expect(verifyFoundProblem(result)).toBe(true);
  });
});
