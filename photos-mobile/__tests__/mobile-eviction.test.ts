/**
 * The residency machinery, actually running on a node.
 *
 * Round 3's R1 is the finding these cases exist for: `runEviction`, `shedLoad`,
 * `previewBudgetReduction`, `setPinned` and `noteDeparture` had **no production
 * caller anywhere in either repo**, and `markOpened` had exactly one — in the
 * fetch-back path, which is to say it was recorded only for records this device
 * had already decided it did not want. Roughly 1,200 lines and eighty tests
 * described a system that never ran.
 *
 * So the point of this file is not that eviction works — `eviction.test.ts` in
 * `@starkeep/sync-engine` covers the pass itself thoroughly. It is that a node
 * assembled the way the app assembles one reaches it, and that the refusals hold
 * when it does. Every case goes through `MobileNode`, never through the manager
 * directly, because the wiring is the thing that was missing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createHLCClock } from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import {
  createInProcessSyncTransport,
  validateRetentionPolicy,
  type NodeRetentionPolicy,
} from "@starkeep/sync-engine";
import { createMobileNode, type MobileNode } from "../src/node";
import { PHONE_RETENTION, PHOTOS_APP_ID, totalBudgetBytes } from "../src/retention";
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
 * Seed the cloud with one photograph.
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
  options: { withChecksum?: boolean } = {},
): Promise<DataRecord> {
  seq += 1;
  const bytes = bytesOf(sizeBytes, seq % 251);
  const hash = hexOf(bytes);
  const rec = {
    id: `rec-${seq}`,
    type: "image/jpeg",
    createdAt: { wallTime: Date.UTC(2026, 0, 1), counter: seq, nodeId: "cloud" },
    updatedAt: { wallTime: Date.UTC(2026, 0, 1), counter: seq, nodeId: "cloud" },
    deletedAt: null,
    version: 1,
    contentHash: hash,
    objectStorageKey: `shared/image/${hash.slice(0, 2)}/${hash}`,
    mimeType: "image/jpeg",
    sizeBytes,
    originAppId: PHOTOS_APP_ID,
    parentId: null,
    originalFilename: `photo-${seq}.jpg`,
  } as DataRecord;
  await cloudDb.put(rec);
  await cloudStorage.put(
    rec.objectStorageKey!,
    bytes,
    options.withChecksum === false ? undefined : { checksumSha256: b64Of(bytes) },
  );
  return rec;
}

async function startPhone(
  retention: NodeRetentionPolicy | undefined,
  options: { cloud?: boolean } = {},
): Promise<MobileNode> {
  const harness = fakeExpoFs();
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
    ...(retention ? { retention } : {}),
  });
}

/**
 * A budget that fits about two 10 KB photos, so a third arrival crosses the
 * high-water mark and the pass has something to do.
 */
const tightPolicy: NodeRetentionPolicy = {
  platform: {
    rows: { "original:image": { prefetch: true, share: 1 } },
    fallback: { prefetch: true, share: 0 },
    budgetBytes: 25 * KB,
  },
  apps: {},
  appFallback: {
    rows: {},
    fallback: { prefetch: true, share: 1 },
    budgetBytes: 25 * KB,
  },
};

/**
 * The policy that actually produces an over-budget class, and why it takes one.
 *
 * A class governed by `keep: "all"` never goes over on the sync path — that is
 * what declining is *for*. `decideResidency` answers `budget-exhausted` and the
 * node simply stops fetching, so the class settles just under its budget and an
 * eviction pass has nothing to do. Which is the correct behaviour, and it means
 * a test that synced against a tight budget and then expected a pass to trigger
 * was testing a situation the design does not produce.
 *
 * The situation it *does* produce is this one. A class with `prefetch: false`
 * fetches nothing
 * proactively, and an explicit `fetchBlob` is deliberately **not subject to the
 * policy** — refusing to show someone their own photograph to stay under a cache
 * budget is not a defensible behaviour, so the fetch lands the bytes and pushes
 * the class over. Eviction is the other half of that bargain: without it, a
 * browsing session grows the class without bound and nothing ever brings it
 * back down.
 *
 * (The other route is a budget *reduction*, which is what `previewReduction`
 * exists to make safe. Same pass, different trigger.)
 */
const onDemandPolicy: NodeRetentionPolicy = {
  platform: {
    rows: { "original:image": { prefetch: false, share: 1 } },
    fallback: { prefetch: false, share: 0 },
    budgetBytes: 25 * KB,
  },
  apps: {},
  appFallback: {
    rows: {},
    fallback: { prefetch: false, share: 1 },
    budgetBytes: 25 * KB,
  },
};

/** Pull every record's bytes down on demand, the way opening each one would. */
async function fetchAll(node: MobileNode, records: readonly DataRecord[]): Promise<void> {
  for (const record of records) {
    const held = await node.databaseAdapter.get(record.id);
    if (held) await node.fetchBlob(held);
  }
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

describe("the phone's built-in policy", () => {
  // The policy is what makes every other function in this file reachable.
  // `bringUpNode` passed none, so `residency` was null on every real device and
  // the whole residency half of the node was configuration nobody had supplied.
  it("is a policy the validator accepts", () => {
    expect(validateRetentionPolicy(PHONE_RETENTION)).toEqual([]);
  });

  it("gives every rung it declares a usable share", () => {
    // N2's defect from the other side: a row whose budget was not a number
    // defeated both the eviction pass and the projection. A share cannot be
    // omitted independently of the budget any more — there is one budget, in
    // the namespace — but a share that is zero or unparseable is still a rung
    // this device silently holds none of.
    for (const [rung, row] of Object.entries(PHONE_RETENTION.apps[PHOTOS_APP_ID]!.rows)) {
      expect(Number.isFinite(row.share), `${rung} has no finite share`).toBe(true);
      expect(row.share, `${rung} claims no share`).toBeGreaterThan(0);
    }
  });

  /**
   * The bug this whole shape exists to make unwritable.
   *
   * The old table gave every row absolute bytes *and* declared a namespace
   * total, with nothing forcing them to agree — and they did not: the photos
   * rows summed to ~14.24 GB against a stated 14 GB, while the comment beside
   * them described the arithmetic they had drifted from. Asserting the identity
   * rather than the numbers, because the numbers are the plan's to choose and
   * the identity is what stops them lying.
   */
  it("divides each namespace's budget exactly, with nothing left over or double-counted", () => {
    for (const namespace of [PHONE_RETENTION.platform, PHONE_RETENTION.apps[PHOTOS_APP_ID]!]) {
      const shares = [namespace.fallback, ...Object.values(namespace.rows)].reduce(
        (sum, r) => sum + r.share,
        0,
      );
      expect(shares).toBeGreaterThan(0);
      const allocated = [namespace.fallback, ...Object.values(namespace.rows)].reduce(
        (sum, r) => sum + Math.floor((namespace.budgetBytes * r.share) / shares),
        0,
      );
      // Within rounding: `budgetBytesFor` floors each line, so the sum can fall
      // a few bytes short of the total and can never exceed it.
      expect(allocated).toBeLessThanOrEqual(namespace.budgetBytes);
      expect(namespace.budgetBytes - allocated).toBeLessThan(
        Object.keys(namespace.rows).length + 1,
      );
    }
  });

  it("adds up to a total an operator could plan a disk around", () => {
    // Not an assertion about the exact number — that is the plan's to choose —
    // but about the order of magnitude, so a slipped decimal in one row is
    // visible here rather than on a full phone.
    const total = totalBudgetBytes();
    expect(total).toBeGreaterThan(10 * 1024 * 1024 * 1024);
    expect(total).toBeLessThan(40 * 1024 * 1024 * 1024);
  });
});

describe("reclaiming space", () => {
  // The behaviour R1 says never runs: "A node that fills a budget never reclaims
  // space. `decideResidency` starts returning `budget-exhausted` → `elide`, so
  // the node silently stops fetching that class and stays full. `evictLine`
  // exists to be the other half of that and is never invoked."
  it("frees bytes once browsing has pushed a class over its budget", async () => {
    const records: DataRecord[] = [];
    for (let i = 0; i < 6; i += 1) records.push(await seedCloud(10 * KB));
    phone = await startPhone(onDemandPolicy);
    await phone.sync();
    await fetchAll(phone, records);

    const before = phone.storageReport().heldBytes;
    expect(before, "on-demand fetches did not land").toBeGreaterThan(25 * KB);

    const outcomes = await phone.reclaimSpace();
    expect(outcomes.some((o) => o.triggered)).toBe(true);
    expect(phone.storageReport().heldBytes).toBeLessThan(before);
    // Down to the low-water mark rather than to the budget, which is what stops
    // a full class evicting on every single arrival.
    expect(phone.storageReport().heldBytes).toBeLessThanOrEqual(25 * KB);
  });

  // The half that matters more. This is the only code in the app that destroys
  // a user's data, and a budget being full is not evidence that a photograph is
  // safe somewhere else.
  it("refuses to delete anything it cannot confirm survives elsewhere", async () => {
    const records: DataRecord[] = [];
    for (let i = 0; i < 6; i += 1) {
      records.push(await seedCloud(10 * KB, { withChecksum: false }));
    }
    phone = await startPhone(onDemandPolicy);
    await phone.sync();
    await fetchAll(phone, records);

    const before = phone.storageReport().heldBytes;
    const outcomes = await phone.reclaimSpace();

    expect(outcomes.flatMap((o) => o.evicted)).toHaveLength(0);
    expect(
      outcomes.some((o) => o.kept.some((k) => k.reason === "not-confirmed-elsewhere")),
    ).toBe(true);
    expect(phone.storageReport().heldBytes).toBe(before);
  });

  // Declining is what keeps a prefetched class inside its budget, and it is
  // why the pass above needed an unprefetched one to have anything to do. Worth
  // pinning, because it is the property that makes eviction the *rare* path
  // rather than a per-arrival one.
  it("has nothing to do while declining is keeping the class under budget", async () => {
    for (let i = 0; i < 6; i += 1) await seedCloud(10 * KB);
    phone = await startPhone(tightPolicy);
    await phone.sync();

    expect(phone.storageReport().heldBytes).toBeLessThanOrEqual(25 * KB);
    const outcomes = await phone.reclaimSpace();
    expect(outcomes.every((o) => !o.triggered)).toBe(true);
    expect(outcomes.flatMap((o) => o.evicted)).toHaveLength(0);
  });

  // A handset nobody has paired has no peer to ask, so there is no evidence
  // about anything on it. The pass must say so rather than quietly freeing
  // nothing, which is indistinguishable from a broken button.
  it("says why, on a phone with no cloud to ask", async () => {
    phone = await startPhone(tightPolicy, { cloud: false });
    const outcomes = await phone.reclaimSpace();
    // Nothing held and nothing to do is a legitimate answer here; what must not
    // happen is a deletion. Asserted as an invariant over whatever ran.
    expect(outcomes.flatMap((o) => o.evicted)).toHaveLength(0);
  });

  it("does nothing at all on a node with no retention policy", async () => {
    for (let i = 0; i < 3; i += 1) await seedCloud(10 * KB);
    phone = await startPhone(undefined);
    await phone.sync();
    expect(await phone.reclaimSpace()).toEqual([]);
    expect(phone.storageReport().configured).toBe(false);
  });
});

describe("pins", () => {
  // Round 3: "`setPinned` has no route and no UI, so `pinned` is always 0 in
  // `resident_blobs`." Which made the retention matrix's pinned figure
  // structurally zero, and made a pin something the system could describe and
  // not do.
  it("survives a pass that would otherwise have taken the bytes", async () => {
    const records: DataRecord[] = [];
    for (let i = 0; i < 6; i += 1) records.push(await seedCloud(10 * KB));
    phone = await startPhone(tightPolicy);
    await phone.sync();

    // Pin everything the phone actually landed, so whatever the pass would have
    // chosen is pinned.
    const held: string[] = [];
    for (const record of records) {
      if (await phone.objectStorage.has(record.objectStorageKey!)) {
        phone.setPinned(record.id, true);
        held.push(record.id);
      }
    }
    expect(held.length, "nothing landed, so there is no pin to test").toBeGreaterThan(0);

    const outcomes = await phone.reclaimSpace();
    expect(outcomes.flatMap((o) => o.evicted)).toHaveLength(0);
    for (const id of held) {
      const record = records.find((r) => r.id === id)!;
      expect(await phone.objectStorage.has(record.objectStorageKey!)).toBe(true);
    }
  });

  it("reports what it was told, and forgets on release", async () => {
    phone = await startPhone(tightPolicy);
    phone.setPinned("rec-1", true);
    expect(phone.isPinned("rec-1")).toBe(true);
    phone.setPinned("rec-1", false);
    expect(phone.isPinned("rec-1")).toBe(false);
  });

  // A pin is meaningful *before* the bytes arrive — pinning is how you ask for
  // something you do not have yet — which is why pins live in their own table
  // rather than on the resident-set row.
  it("can be set for a record whose bytes are not here", async () => {
    phone = await startPhone(tightPolicy);
    expect(() => phone!.setPinned("never-seen", true)).not.toThrow();
    expect(phone.isPinned("never-seen")).toBe(true);
  });
});

describe("what the Storage section reads", () => {
  it("reports held bytes against the policy's budget", async () => {
    for (let i = 0; i < 2; i += 1) await seedCloud(10 * KB);
    phone = await startPhone(tightPolicy);
    await phone.sync();

    const report = phone.storageReport();
    expect(report.configured).toBe(true);
    expect(report.heldBytes).toBeGreaterThan(0);
    expect(report.classes.some((c) => c.sizeClass === "starkeep:original:image")).toBe(true);
  });

  it("says plainly that nothing binds when there is no policy", async () => {
    phone = await startPhone(undefined);
    expect(phone.storageReport()).toEqual({
      classes: [],
      heldBytes: 0,
      budgetBytes: 0,
      configured: false,
    });
  });
});

describe("reconciling the index against the disk", () => {
  // R2: "The index is a cache of a fact the filesystem also knows, so it can be
  // rebuilt by walking storage. No such rebuild exists, so there is nothing to
  // correct the drift either." The drift is real: the pass deletes through the
  // storage adapter and updates the index after, so a process killed between the
  // two leaves a row claiming bytes that are gone.
  it("stops counting bytes that are no longer on disk", async () => {
    const record = await seedCloud(10 * KB);
    phone = await startPhone(tightPolicy);
    await phone.sync();
    expect(phone.storageReport().heldBytes).toBe(10 * KB);

    // Delete behind the index's back — exactly what a crash between the two
    // writes leaves behind.
    await phone.objectStorage.delete(record.objectStorageKey!);
    expect(phone.storageReport().heldBytes, "the index has not noticed yet").toBe(10 * KB);

    await phone.reclaimSpace();
    expect(phone.storageReport().heldBytes).toBe(0);
  });
});

describe("opening a photo", () => {
  // R1: "`openedWithinDays` is dead on the laptop. `last_opened_at_ms` is only
  // ever written by `markOpened`, which the LDS never calls." On the phone it
  // had one caller, in the fetch-back path — so it was recorded only for records
  // this device had already declined, which is the opposite of a working set.
  //
  // The policy field that read it is gone; the column matters more, not less.
  // It is now the *primary* term of the only ordering the system has, on both
  // the eviction side and the admission side.
  it("records the open, so the eviction order can read it", async () => {
    const record = await seedCloud(10 * KB);
    phone = await startPhone(tightPolicy);
    await phone.sync();

    const before = phone.residency!.index.get(record.objectStorageKey!);
    expect(before?.lastOpenedAtMs ?? null).toBeNull();

    phone.noteOpened(record.id);

    const after = phone.residency!.index.get(record.objectStorageKey!);
    expect(after?.lastOpenedAtMs).toBeTypeOf("number");
  });

  it("is harmless for a record this node holds no bytes for", async () => {
    phone = await startPhone(tightPolicy);
    expect(() => phone!.noteOpened("never-seen")).not.toThrow();
  });
});
