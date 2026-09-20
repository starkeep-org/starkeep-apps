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
import { fakeExpoFs } from "./helpers/fake-expo-fs";

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
    expect(await phone.objectStorage.has(key)).toBe(true);
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
    ).toBe(false);
    expect(phone.photosData.rows("renditions")).toEqual([row]);
    expect(phone.photosData.rows("_starkeep_sync_records")).toHaveLength(1);
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
      retention: policy,
    });
    expect(await reopened.databaseAdapter.get(parent.id)).not.toBeNull();
    await reopened.sync();
    expect(reopened.photosData.rows("renditions")).toEqual(before);
    expect(await reopened.objectStorage.has(key)).toBe(false);
    expect(await reopened.fetchRendition(key)).toBe(true);
    expect(await reopened.objectStorage.has(key)).toBe(true);
  });
});
