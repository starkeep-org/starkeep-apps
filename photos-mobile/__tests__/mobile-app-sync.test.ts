import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createDataRecord,
  createHLCClock,
} from "@starkeep/protocol-primitives";
import { sqliteCompiler as qb } from "@starkeep/storage-sqlite";
import { MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import {
  createInProcessSyncTransport,
  type NodeRetentionPolicy,
} from "@starkeep/sync-engine";
import { createOpSqliteDriver } from "../src/db/op-sqlite-driver";
import {
  createMobileNode,
  type MobileNode,
  type MobileNodeOptions,
} from "../src/node";
import { deriveForRecord } from "../src/photos/derive-ladder";
import { PHOTOS_FILE_PREFIX } from "../src/photos/app-data";
import { listLibrary } from "../src/library";
import { fakeExpoFs } from "./helpers/fake-expo-fs";

/** One justified row of a phone screen, as `paint-rule.test.ts` states it. */
const GRID = { targetRowHeight: 120, containerWidth: 350, devicePixelRatio: 3 };

const hash = async (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const nodes: MobileNode[] = [];
const databases: DatabaseSync[] = [];
let directory: string;
let nextDatabase = 0;
const paths = new Map<MobileNode, string>();
async function makeNode(
  nodeId: string,
  extra: Partial<MobileNodeOptions> = {},
) {
  const path =
    extra.databasePath ?? join(directory, `${nextDatabase++}.sqlite`);
  const db = new DatabaseSync(path);
  databases.push(db);
  const node = await createMobileNode({
    nodeId,
    databasePath: path,
    localObjectStorage: new MockObjectStorageAdapter(),
    sqliteDriver: createOpSqliteDriver({
      open: () => ({
        executeSync(query, params) {
          const stmt = db.prepare(query);
          if (/^\s*(select|pragma|with)/i.test(query))
            return { rows: stmt.all(...((params ?? []) as never[])) };
          stmt.run(...((params ?? []) as never[]));
          return { rows: [] };
        },
        close: () => db.close(),
      }),
    }),
    ...extra,
  });
  nodes.push(node);
  paths.set(node, path);
  return node;
}
const policy: NodeRetentionPolicy = {
  platform: {
    budgetBytes: 10000,
    rows: {},
    fallback: { share: 1, prefetch: true },
  },
  apps: { photos: { budgetBytes: 1 } },
  appFallback: { budgetBytes: 0 },
};
let desktop: MobileNode;
let phone: MobileNode;
function channel(peer: MobileNode, app: boolean) {
  return {
    remoteObjectStorage: peer.objectStorage,
    transport: createInProcessSyncTransport({
      databaseAdapter: peer.databaseAdapter,
      objectStorage: peer.objectStorage,
      clock: createHLCClock({ nodeId: "desktop" }),
      syncSharedRecords: !app,
      ...(app ? { appSyncableSource: peer.photosData.source } : {}),
    }),
  };
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "starkeep-mobile-phase4-"));
  desktop = await makeNode("desktop");
  phone = await makeNode("phone", {
    cloud: channel(desktop, false),
    photosCloud: channel(desktop, true),
    retention: policy,
    deviceMedia: { fs: fakeExpoFs().fs },
  });
});
afterEach(async () => {
  for (const node of nodes.splice(0)) await node.close();
  databases.length = 0;
  paths.clear();
  rmSync(directory, { recursive: true, force: true });
});
async function derive() {
  const clock = createHLCClock({ nodeId: "phone" });
  const parent = createDataRecord(
    {
      type: "image/jpeg",
      originAppId: "photos",
      contentHash: "a".repeat(64),
      objectStorageKey: "shared/image/original",
      sizeBytes: 2000,
      originalFilename: "camera.jpg",
    },
    clock,
  );
  await phone.databaseAdapter.put(parent);
  await phone.databaseAdapter.putMetadata("image/jpeg", {
    recordId: parent.id,
    width: 4000,
    height: 3000,
  });
  phone.mediaAliases!.add({
    objectStorageKey: parent.objectStorageKey,
    recordId: parent.id,
    contentUri: "content://camera/1",
    assetId: "1",
    sizeBytes: 2000,
    contentType: "image/jpeg",
    modificationTimeMs: 1,
    addedAtMs: 1,
  });
  expect(
    await deriveForRecord(
      {
        aliases: phone.mediaAliases!,
        database: phone.databaseAdapter,
        hash,
        photosData: phone.photosData,
        publishRendition: (row, bytes) => phone.publishRendition(row, bytes),
        encode: async () => ({
          width: 4000,
          height: 3000,
          encode: async (longEdge) => ({
            bytes: new Uint8Array([longEdge >> 8, longEdge & 255]),
            width: longEdge,
            height: Math.round(longEdge * 0.75),
          }),
          release() {},
        }),
      },
      parent,
      320,
    ),
  ).toBe(1);
  return parent;
}

describe("Photos app-specific mobile sync", () => {
  it("prefetches remote grid rungs within Photos shares without downloading the original", async () => {
    const receiver = await makeNode("grid-phone", {
      cloud: channel(desktop, false), photosCloud: channel(desktop, true),
      retention: { ...policy, platform: { ...policy.platform, fallback: { share: 1, prefetch: false } },
        apps: { photos: { budgetBytes: 10000000 } } },
    });
    const parent = createDataRecord({ type: "image/jpeg", originAppId: "photos",
      contentHash: "a".repeat(64), objectStorageKey: "shared/image/large-original", sizeBytes: 7000000 }, createHLCClock({ nodeId: "desktop" }));
    await desktop.databaseAdapter.put(parent);
    await desktop.databaseAdapter.putMetadata("image/jpeg", { recordId: parent.id, width: 4000, height: 3000 });
    for (const [sizeClass, edge] of [["image-xsmall", 320], ["image-thumb", 640], ["image-large", 3840]] as const) {
      const bytes = new Uint8Array(14000).fill(edge % 255);
      const contentHash = await hash(bytes);
      await desktop.publishRendition({ parent_record_id: parent.id, size_class: sizeClass,
        sub_key: `renditions/${parent.id}/${sizeClass}/${contentHash}.avif`, content_hash: contentHash,
        width: edge, height: edge, size_bytes: bytes.length, content_type: "image/avif" }, bytes);
    }
    await receiver.sync();
    const rows = receiver.photosData.rows("renditions");
    expect(rows).toHaveLength(3);
    await receiver.acquireQueued();
    for (const row of rows) {
      expect(await receiver.objectStorage.has(PHOTOS_FILE_PREFIX + row.sub_key)).toBe(row.size_class !== "image-large");
    }
    expect(await receiver.objectStorage.has(parent.objectStorageKey)).toBe(false);
    // The resident bytes keep the grid drawable after the peer disappears.
    for (const row of rows) await desktop.objectStorage.delete(PHOTOS_FILE_PREFIX + row.sub_key);
    expect(rows.filter(r => receiver.residency!.index.get(PHOTOS_FILE_PREFIX + r.sub_key)?.resident)).toHaveLength(2);
  });

  it("draws every tile of a synced grid offline, from rungs and never from an original", async () => {
    // The prefetch test above proves the bytes are resident. This one asks the
    // grid what it would actually paint, which is the question an offline phone
    // is really asking: a resident rung nothing resolves to is the same blank
    // tile as a rung that never arrived.
    const receiver = await makeNode("offline-phone", {
      cloud: channel(desktop, false), photosCloud: channel(desktop, true),
      retention: { ...policy, platform: { ...policy.platform, fallback: { share: 1, prefetch: false } },
        apps: { photos: { budgetBytes: 10000000 } } },
    });
    const clock = createHLCClock({ nodeId: "desktop" });
    const parents = [];
    for (let index = 0; index < 3; index++) {
      const parent = createDataRecord({ type: "image/jpeg", originAppId: "photos",
        contentHash: String(index).repeat(64), objectStorageKey: `shared/image/original-${index}`,
        sizeBytes: 7000000, originalFilename: `photo-${index}.jpg` }, clock);
      await desktop.databaseAdapter.put(parent);
      await desktop.databaseAdapter.putMetadata("image/jpeg", { recordId: parent.id, width: 4000, height: 3000 });
      for (const [sizeClass, edge] of [["image-xsmall", 320], ["image-thumb", 640]] as const) {
        const bytes = new Uint8Array(14000).fill((index * 16 + edge) % 255);
        const contentHash = await hash(bytes);
        await desktop.publishRendition({ parent_record_id: parent.id, size_class: sizeClass,
          sub_key: `renditions/${parent.id}/${sizeClass}/${contentHash}.avif`, content_hash: contentHash,
          width: edge, height: Math.round(edge * 0.75), size_bytes: bytes.length, content_type: "image/avif" }, bytes);
      }
      parents.push(parent);
    }
    await receiver.sync();
    await receiver.acquireQueued();

    // The peer goes away, bytes and all. Everything the grid draws from here on
    // is what this device already holds.
    for (const row of receiver.photosData.rows("renditions")) {
      await desktop.objectStorage.delete(PHOTOS_FILE_PREFIX + row.sub_key);
    }
    const resident = new Set<string>();
    for (const row of receiver.photosData.rows("renditions")) {
      const key = PHOTOS_FILE_PREFIX + row.sub_key;
      if (await receiver.objectStorage.has(key)) resident.add(key);
    }
    // `localFileUriFor` is the device store's synchronous answer to "are these
    // bytes here"; the mock adapter has no such method, so the resident set read
    // above stands in for it.
    const objectStorage = Object.assign(Object.create(Object.getPrototypeOf(receiver.objectStorage)),
      receiver.objectStorage, { localFileUriFor: (key: string) => resident.has(key) ? `file:///${key}` : null });
    const page = await listLibrary({ database: receiver.databaseAdapter, objectStorage,
      photosData: receiver.photosData, aliases: null }, { limit: 10, grid: GRID });

    expect(page.items).toHaveLength(parents.length);
    for (const item of page.items) {
      expect(item.uri, `${item.record.originalFilename} paints nothing offline`).toBeTruthy();
      expect(resident.has(item.uri!.replace("file:///", ""))).toBe(true);
      // Never the photograph itself: the originals were not downloaded, and a
      // grid that reached for one would be spending 7 MB on a 120 pt tile.
      expect(item.uri).not.toContain(item.record.objectStorageKey);
      expect(item.bytesHere).toBe(false);
    }
  });

  it("fetches a published rung when the camera-roll asset behind an alias is gone", async () => {
    // Repair selects on readable original bytes, not on provenance. An alias
    // row outlives the photograph it points at — the user deleted it from the
    // camera roll — and a node that read the row as "mine to derive" would
    // suppress the one download that can repair this rung.
    const fake = fakeExpoFs();
    const receiver = await makeNode("stale-alias-phone", {
      cloud: channel(desktop, false), photosCloud: channel(desktop, true),
      deviceMedia: { fs: fake.fs },
      retention: { ...policy, platform: { ...policy.platform, fallback: { share: 1, prefetch: false } },
        apps: { photos: { budgetBytes: 10000000 } } },
    });
    const parent = createDataRecord({ type: "image/jpeg", originAppId: "photos",
      contentHash: "b".repeat(64), objectStorageKey: "shared/image/deleted-original",
      sizeBytes: 7000000, originalFilename: "deleted.jpg" }, createHLCClock({ nodeId: "desktop" }));
    await desktop.databaseAdapter.put(parent);
    await desktop.databaseAdapter.putMetadata("image/jpeg", { recordId: parent.id, width: 4000, height: 3000 });
    const bytes = new Uint8Array(14000).fill(7);
    const contentHash = await hash(bytes);
    const subKey = `renditions/${parent.id}/image-thumb/${contentHash}.avif`;
    await desktop.publishRendition({ parent_record_id: parent.id, size_class: "image-thumb",
      sub_key: subKey, content_hash: contentHash, width: 640, height: 480,
      size_bytes: bytes.length, content_type: "image/avif" }, bytes);

    // The row says this device holds the photograph; the media store says the
    // asset is gone. Nothing writes the URI into the fake file system, which is
    // what a deleted camera-roll entry looks like from here.
    await receiver.sync();
    receiver.mediaAliases!.add({ objectStorageKey: parent.objectStorageKey, recordId: parent.id,
      contentUri: "content://camera/deleted", assetId: "deleted", sizeBytes: 7000000,
      contentType: "image/jpeg", modificationTimeMs: 1, addedAtMs: 1 });
    expect(await receiver.objectStorage.has(parent.objectStorageKey)).toBe(false);

    await receiver.acquireQueued();
    expect(await receiver.objectStorage.has(PHOTOS_FILE_PREFIX + subKey)).toBe(true);
    // The rung came down; the 7 MB photograph did not.
    expect(await receiver.objectStorage.has(parent.objectStorageKey)).toBe(false);
  });

  it("declines an on-demand rung larger than its Photos share", async () => {
    const parent = await derive();
    await phone.photosEngine!.sync();
    const row = phone.photosData.rows("renditions")[0]!;
    const key = PHOTOS_FILE_PREFIX + row.sub_key;
    await phone.objectStorage.delete(key);
    phone.residency!.index.markDeparted(key);
    phone.mediaAliases!.remove(parent.objectStorageKey);
    expect(await phone.fetchRendition(key)).toBe(false);
    expect(await phone.objectStorage.has(key)).toBe(false);
  });

  it("round-trips a desktop caption independently of shared-record watermarks", async () => {
    desktop.photosData.write("image_enriched", {
      record_id: "photo",
      caption: "Desktop caption",
    });
    await phone.sync();
    expect(phone.photosData.rows("image_enriched")[0]?.caption).toBe(
      "Desktop caption",
    );
    phone.photosData.write("image_enriched", {
      record_id: "photo",
      caption: "Phone caption",
    });
    expect((await phone.sync())?.complete).toBe(true);
    expect(desktop.photosData.rows("image_enriched")[0]?.caption).toBe(
      "Phone caption",
    );
    const keys = databases[1]!
      .prepare(qb.selectFrom("sync_state").select("key").compile().sql)
      .all()
      .map((r) => r.key);
    expect(keys).toContain("photos:watermarks");
    expect(keys).toContain("watermarks");
    expect((await phone.verify())?.supported).toBe(true);
  });
  it("ships a phone-derived rung as one app row and blob, without a shared child", async () => {
    const parent = await derive();
    await phone.photosEngine!.sync();
    await phone.photosEngine!.sync();
    const rows = desktop.photosData.rows("renditions");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.parent_record_id).toBe(parent.id);
    const key = PHOTOS_FILE_PREFIX + rows[0]!.sub_key;
    expect(await desktop.objectStorage.has(key)).toBe(true);
    expect((await desktop.databaseAdapter.query({})).records).toHaveLength(0);
    expect((await phone.databaseAdapter.query({})).records).toHaveLength(1);
    expect(
      phone
        .storageReport()
        .classes.find((c) => c.sizeClass === "photos:unclassified")?.heldBytes,
    ).toBe(2);
    await phone.reclaimSpace();
    // Photos enforces its own one-byte ceiling; the published rows survive.
    expect(await phone.objectStorage.has(key)).toBe(false);
    expect(phone.photosData.rows("renditions")).toHaveLength(1);
    expect(await desktop.objectStorage.has(key)).toBe(true);
  });
  it("keeps the first publication when another encoder produces different bytes", async () => {
    await derive();
    const row = phone.photosData.rows("renditions")[0]!;
    const bytes = new Uint8Array([9, 9, 9]);
    const contentHash = await hash(bytes);
    expect(
      await phone.publishRendition(
        {
          parent_record_id: String(row.parent_record_id),
          size_class: String(row.size_class),
          sub_key: `renditions/${row.parent_record_id}/${row.size_class}/${contentHash}.avif`,
          content_hash: contentHash,
          width: 320,
          height: 240,
          size_bytes: 3,
          content_type: "image/avif",
        },
        bytes,
      ),
    ).toBe(true);
    expect(phone.photosData.rows("renditions")).toEqual([row]);
    expect(phone.photosData.rows("_starkeep_sync_records")).toHaveLength(1);
    const local = phone.photosData.localRows()[0]!;
    expect(await phone.objectStorage.has(PHOTOS_FILE_PREFIX + local.sub_key)).toBe(true);
    expect(local.content_hash).toBe(contentHash);
    await phone.photosEngine!.sync();
    expect(desktop.photosData.localRows()).toEqual([]);
    expect(desktop.photosData.rows("renditions")).toHaveLength(1);
  });
  it("removes only local Photos data and clears Photos watermarks without tombstones", async () => {
    const parent = await derive();
    await phone.photosEngine!.sync();
    const before = desktop.photosData.rows("renditions");
    const key = PHOTOS_FILE_PREFIX + before[0]!.sub_key;
    const unrelatedKey = "apps/memo/syncable/audio";
    await phone.objectStorage.put(unrelatedKey, new Uint8Array([1]));
    await phone.objectStorage.put(
      PHOTOS_FILE_PREFIX + "orphan",
      new Uint8Array([2]),
    );
    await phone.removePhotosData();
    await phone.exchange();
    expect(desktop.photosData.rows("renditions")).toEqual(before);
    expect(await desktop.objectStorage.has(key)).toBe(true);
    expect(phone.photosData.rows("renditions")).toEqual([]);
    expect(await phone.objectStorage.has(key)).toBe(false);
    expect(await phone.objectStorage.has(PHOTOS_FILE_PREFIX + "orphan")).toBe(
      false,
    );
    expect(await phone.objectStorage.has(unrelatedKey)).toBe(true);
    expect(await phone.databaseAdapter.get(parent.id)).not.toBeNull();
    expect(
      databases[1]!
        .prepare(
          qb
            .selectFrom("sync_state")
            .select("key")
            .where("key", "like", "photos:%")
            .compile().sql,
        )
        .all("photos:%"),
    ).toEqual([]);
    const databasePath = paths.get(phone)!;
    await phone.close();
    nodes.splice(nodes.indexOf(phone), 1);
    const reopened = await makeNode("phone", {
      databasePath,
      photosCloud: channel(desktop, true),
      retention: { ...policy, apps: { photos: { budgetBytes: 1000 } } },
    });
    expect(await reopened.databaseAdapter.get(parent.id)).not.toBeNull();
    await reopened.sync();
    expect(reopened.photosData.rows("renditions")).toEqual(before);
    expect(await reopened.objectStorage.has(key)).toBe(false);
    expect(await reopened.fetchRendition(key)).toBe(true);
    expect(await reopened.objectStorage.has(key)).toBe(true);
  });
});
