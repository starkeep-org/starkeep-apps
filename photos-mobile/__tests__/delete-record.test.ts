/**
 * Deleting a library item from the phone: the same cascade Photos web makes,
 * and the camera-roll assets the caller asks Android to trash.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { compareHLC, createDataRecord, createHLCClock, type DataRecord } from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, type RawDatabase } from "@starkeep/storage-adapter";
import { createSqliteMediaAliasStore, type MediaAliasStore } from "../src/media/media-alias";
import { deleteLibraryRecord, mediaStoreItemUri, type DeleteRecordDeps } from "../src/photos/delete-record";

const clock = createHLCClock({ nodeId: "phone" });

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

let database: MockDatabaseAdapter;
let aliases: MediaAliasStore;
let gone: Set<string>;
let seq = 0;

function deps(): DeleteRecordDeps {
  return { database, clock, aliases, assetExists: (uri) => !gone.has(uri) };
}

async function put(fields: { type: string; parentId?: string }): Promise<DataRecord> {
  seq += 1;
  const record = createDataRecord(
    {
      type: fields.type,
      originAppId: "photos",
      contentHash: String(seq).padStart(64, "0"),
      objectStorageKey: `shared/${fields.type.split("/")[0]}/${seq}`,
      sizeBytes: 1024,
      originalFilename: `file-${seq}`,
      ...(fields.parentId ? { parentId: fields.parentId as DataRecord["id"] } : {}),
    },
    clock,
  );
  await database.put(record);
  return record;
}

/** A video from the camera roll, with a poster that carries a label and metadata. */
async function aliasedVideo(): Promise<{ video: DataRecord; poster: DataRecord; uri: string }> {
  const video = await put({ type: "video/mp4" });
  const uri = `content://media/external/video/media/${5000 + seq}`;
  aliases.add({
    objectStorageKey: video.objectStorageKey!,
    recordId: video.id,
    contentUri: `${uri}?requireOriginal=1`,
    assetId: String(5000 + seq),
    sizeBytes: 1024,
    contentType: null,
    modificationTimeMs: 1,
    addedAtMs: 1,
  });
  await database.putMetadata("video/mp4", { recordId: video.id, duration_ms: 4000 });
  const poster = await put({ type: "image/jpeg", parentId: video.id });
  await database.upsertLabels([
    {
      recordId: poster.id,
      appId: "photos",
      key: "derived",
      value: "video-poster-thumb",
      recordType: "image/jpeg",
      hlc: clock.now(),
    },
  ]);
  return { video, poster, uri };
}

beforeEach(async () => {
  database = new MockDatabaseAdapter();
  await database.init();
  aliases = createSqliteMediaAliasStore({ db: rawDb() });
  gone = new Set();
  seq = 0;
});

describe("deleteLibraryRecord", () => {
  it("tombstones the original, its children, and their metadata and labels", async () => {
    const { video, poster } = await aliasedVideo();
    const other = await put({ type: "image/jpeg" });
    // The adapter answers a tombstoned metadata row, so the write is what shows.
    const tombstoneMetadata = vi.spyOn(database, "tombstoneMetadata");

    const outcome = await deleteLibraryRecord(deps(), video.id);

    expect(outcome.deleted).toBe(true);
    expect((await database.get(video.id))?.deletedAt).not.toBeNull();
    expect((await database.get(poster.id))?.deletedAt).not.toBeNull();
    expect((await database.get(other.id))?.deletedAt).toBeNull();
    expect(tombstoneMetadata.mock.calls.map(([type, id]) => [type, id])).toEqual([
      ["image/jpeg", poster.id],
      ["video/mp4", video.id],
    ]);
    expect((await database.getLabelsByRecordIds([poster.id])).get(poster.id) ?? []).toEqual([]);
  });

  // Children first, so a peer applying rows in clock order never holds a live
  // child of a deleted original.
  it("deletes the children before the original", async () => {
    const { video, poster } = await aliasedVideo();

    await deleteLibraryRecord(deps(), video.id);

    const original = (await database.get(video.id))!.deletedAt!;
    const child = (await database.get(poster.id))!.deletedAt!;
    expect(compareHLC(child, original)).toBe(-1);
  });

  it("answers the bare camera-roll URI to trash, and keeps the alias", async () => {
    const { video, uri } = await aliasedVideo();

    const outcome = await deleteLibraryRecord(deps(), video.id);

    expect(outcome.cameraRollUris).toEqual([uri]);
    // The alias is what keeps import from re-minting the record while the
    // asset is still in the camera roll.
    expect(aliases.ofRecord(video.id)).toHaveLength(1);
  });

  it("answers no URI for an asset already gone from the camera roll", async () => {
    const { video, uri } = await aliasedVideo();
    gone.add(uri);

    expect((await deleteLibraryRecord(deps(), video.id)).cameraRollUris).toEqual([]);
  });

  it("answers no URI for a record this phone did not import", async () => {
    const photo = await put({ type: "image/jpeg" });

    const outcome = await deleteLibraryRecord(deps(), photo.id);

    expect(outcome).toEqual({ deleted: true, cameraRollUris: [] });
  });

  it("does nothing for a record already deleted or unknown", async () => {
    const { video } = await aliasedVideo();
    await deleteLibraryRecord(deps(), video.id);
    const first = (await database.get(video.id))!.deletedAt;

    expect(await deleteLibraryRecord(deps(), video.id)).toEqual({ deleted: false, cameraRollUris: [] });
    expect((await database.get(video.id))!.deletedAt).toEqual(first);
    expect(await deleteLibraryRecord(deps(), "missing" as DataRecord["id"])).toEqual({
      deleted: false,
      cameraRollUris: [],
    });
  });
});

describe("mediaStoreItemUri", () => {
  it("drops the query and refuses anything but a MediaStore URI", () => {
    expect(mediaStoreItemUri("content://media/external/images/media/12?requireOriginal=1")).toBe(
      "content://media/external/images/media/12",
    );
    expect(mediaStoreItemUri("content://media/external/images/media/12")).toBe(
      "content://media/external/images/media/12",
    );
    expect(mediaStoreItemUri("file:///data/objects/abc")).toBeNull();
  });
});
