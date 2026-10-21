/**
 * The phone's video posters and container facts.
 *
 * A poster made here must be the record any node would make: Photos on the
 * desktop finds its own posters by the `photos/derived` label and sizes the
 * tile from the metadata, and its sweep skips a class that is already present.
 * A poster that differed in any of those would be invisible to the grid, or
 * made twice.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  createDataRecord,
  createHLCClock,
  dataRecordObjectKey,
  LOCAL_USER_SEGMENT,
  type DataRecord,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
  type RawDatabase,
} from "@starkeep/storage-adapter";
import { createSqliteMediaAliasStore, type MediaAliasStore } from "../src/media/media-alias";
import {
  backfillVideoPosters,
  POSTER_JPEG_QUALITY,
  publishVideoPosters,
  writeVideoFacts,
  type ExtractPosters,
  type VideoContainerFacts,
  type VideoPosterDeps,
} from "../src/photos/video-posters";

const hash = async (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

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

const URI = "content://media/external/video/media/5185?requireOriginal=1";
const FACTS: VideoContainerFacts = {
  durationMs: 156_495,
  width: 1920,
  height: 1080,
  capturedAt: "2026-09-27T16:12:21.000Z",
  gpsLat: null,
  gpsLon: null,
};

let database: MockDatabaseAdapter;
let objectStorage: MockObjectStorageAdapter;
let aliases: MediaAliasStore;
let scratch: Map<string, Uint8Array>;
let extractCalls: Array<{ uri: string; timeUs: number; outputs: unknown; quality: number }>;

/** Writes a distinct JPEG-ish payload per output, sized as the native side would. */
const extractPosters: ExtractPosters = async (uri, timeUs, outputs, quality) => {
  extractCalls.push({ uri, timeUs, outputs, quality });
  return outputs.map((output) => {
    const long = Math.min(output.maxLongEdge, 1920);
    scratch.set(output.path, new TextEncoder().encode(`jpeg ${output.path}`));
    return { path: output.path, width: long, height: Math.round((long * 9) / 16 / 2) * 2 };
  });
};

function posterDeps(overrides: Partial<VideoPosterDeps> = {}): VideoPosterDeps {
  return {
    database,
    objectStorage,
    clock: createHLCClock({ nodeId: "phone" }),
    hash,
    userId: () => LOCAL_USER_SEGMENT,
    readFacts: async () => FACTS,
    extractPosters,
    scratchPath: (name) => `file:///cache/posters/${name}`,
    readScratch: (path) => scratch.get(path)!,
    removeScratch: (path) => void scratch.delete(path),
    ...overrides,
  };
}

async function storedVideo(filename = "PXL_20260927_160942045.mp4"): Promise<DataRecord> {
  const record = createDataRecord(
    {
      type: "video/mp4",
      originAppId: "photos",
      contentHash: "ab".repeat(32),
      objectStorageKey: `shared/local/video/ab/${"ab".repeat(32)}`,
      sizeBytes: 391_684_623,
      originalFilename: filename,
    },
    createHLCClock({ nodeId: "phone" }),
  );
  await database.put(record);
  return record;
}

async function childrenOf(parent: DataRecord): Promise<DataRecord[]> {
  const { records } = await database.query({
    filters: [{ field: "parentId", operator: "eq", value: parent.id }],
    limit: 50,
  });
  return records;
}

beforeEach(async () => {
  database = new MockDatabaseAdapter();
  await database.init();
  objectStorage = new MockObjectStorageAdapter();
  await objectStorage.init();
  aliases = createSqliteMediaAliasStore({ db: rawDb() });
  scratch = new Map();
  extractCalls = [];
});

describe("publishVideoPosters", () => {
  it("writes both poster rungs in the desktop's record shape", async () => {
    const video = await storedVideo();
    expect(await publishVideoPosters(posterDeps(), video, URI, FACTS)).toBe(2);

    const posters = await childrenOf(video);
    expect(posters.map((p) => p.originalFilename).sort()).toEqual([
      "video-poster-720p_PXL_20260927_160942045.jpg",
      "video-poster-thumb_PXL_20260927_160942045.jpg",
    ]);
    for (const poster of posters) {
      expect(poster).toMatchObject({ type: "image/jpeg", mimeType: "image/jpeg", parentId: video.id });
      // Bytes first: the record names bytes this node already holds.
      expect(await objectStorage.has(poster.objectStorageKey!)).toBe(true);
      expect(poster.objectStorageKey).toBe(
        dataRecordObjectKey(LOCAL_USER_SEGMENT, "image/jpeg", poster.contentHash!),
      );
    }
    const labels = await database.getLabelsByRecordIds(posters.map((p) => p.id));
    const values = posters.map((p) => labels.get(p.id)?.map((l) => `${l.appId}/${l.key}=${l.value}`));
    expect(values.flat().sort()).toEqual([
      "photos/derived=video-poster-720p",
      "photos/derived=video-poster-thumb",
    ]);
    const metadata = await database.getMetadataByIds("image", posters.map((p) => p.id));
    expect(posters.map((p) => metadata.get(p.id)?.["width"]).sort()).toEqual([1280, 640]);
  });

  it("takes the frame where the desktop does, at quality 81, and cleans up", async () => {
    const video = await storedVideo();
    await publishVideoPosters(posterDeps(), video, URI, FACTS);
    expect(extractCalls).toHaveLength(1);
    // min(1 s, a tenth of the duration).
    expect(extractCalls[0]).toMatchObject({ uri: URI, timeUs: 1_000_000, quality: POSTER_JPEG_QUALITY });
    expect(POSTER_JPEG_QUALITY).toBe(81);
    expect(scratch.size).toBe(0);

    await publishVideoPosters(posterDeps(), await storedVideo("short.mp4"), URI, {
      ...FACTS,
      durationMs: 4_000,
    });
    expect(extractCalls[1]!.timeUs).toBe(400_000);
  });

  it("makes only the thumb rung for a source no larger than it", async () => {
    const video = await storedVideo();
    await publishVideoPosters(posterDeps(), video, URI, { ...FACTS, width: 640, height: 360 });
    expect((await childrenOf(video)).map((p) => p.originalFilename)).toEqual([
      "video-poster-thumb_PXL_20260927_160942045.jpg",
    ]);
  });

  it("skips the rungs the video already has", async () => {
    const video = await storedVideo();
    const written = await publishVideoPosters(
      posterDeps(),
      video,
      URI,
      FACTS,
      new Set(["video-poster-thumb", "video-poster-720p"] as const),
    );
    expect(written).toBe(0);
    expect(extractCalls).toHaveLength(0);
  });
});

describe("writeVideoFacts", () => {
  it("writes the container's date when the row has none, and never overwrites one", async () => {
    const id = "rec-1" as StarkeepId;
    expect(await writeVideoFacts(database, id, "video/mp4", FACTS, undefined)).toBe(true);
    expect((await database.getMetadataByIds("video", [id])).get(id)?.["captured_at"]).toBe(
      FACTS.capturedAt,
    );
    expect(
      await writeVideoFacts(database, id, "video/mp4", FACTS, { recordId: id, captured_at: "earlier" }),
    ).toBe(false);
    expect(await writeVideoFacts(database, id, "video/mp4", { ...FACTS, capturedAt: null }, undefined)).toBe(
      false,
    );
  });

  it("writes the container's location as a pair when the row has none, and never overwrites one", async () => {
    const id = "rec-2" as StarkeepId;
    const located = { ...FACTS, capturedAt: null, gpsLat: 42.2545, gpsLon: -83.7165 };
    expect(await writeVideoFacts(database, id, "video/mp4", located, undefined)).toBe(true);
    const row = (await database.getMetadataByIds("video", [id])).get(id);
    expect([row?.["gps_lat"], row?.["gps_lon"]]).toEqual([42.2545, -83.7165]);
    expect(
      await writeVideoFacts(database, id, "video/mp4", located, { recordId: id, gps_lat: 1, gps_lon: 2 }),
    ).toBe(false);
    expect(
      await writeVideoFacts(database, id, "video/mp4", { ...located, gpsLon: null }, undefined),
    ).toBe(false);
  });
});

describe("backfillVideoPosters", () => {
  function alias(record: DataRecord, n: number) {
    aliases.add({
      objectStorageKey: record.objectStorageKey!,
      recordId: record.id,
      contentUri: `content://media/external/video/media/${n}`,
      assetId: String(n),
      sizeBytes: record.sizeBytes,
      contentType: null,
      modificationTimeMs: 1_700_000_000_000,
      addedAtMs: 1_700_000_000_000,
    });
  }

  it("gives an imported video its posters and capture time, then leaves it alone", async () => {
    const video = await storedVideo();
    alias(video, 1);
    const deps = { ...posterDeps(), aliases };

    const first = await backfillVideoPosters(deps, { limit: 24 });
    expect(first).toMatchObject({ scanned: 1, written: 2, complete: true });
    expect((await database.getMetadataByIds("video", [video.id])).get(video.id)?.["captured_at"]).toBe(
      FACTS.capturedAt,
    );

    const second = await backfillVideoPosters(deps, { limit: 24 });
    expect(second).toMatchObject({ scanned: 0, written: 0 });
    expect(extractCalls).toHaveLength(1);
  });

  it("passes over stills, and survives a clip the retriever cannot open", async () => {
    const still = createDataRecord(
      {
        type: "image/jpeg",
        originAppId: "photos",
        contentHash: "cd".repeat(32),
        objectStorageKey: `shared/local/image/cd/${"cd".repeat(32)}`,
        sizeBytes: 3_000,
        originalFilename: "IMG.jpg",
      },
      createHLCClock({ nodeId: "phone" }),
    );
    await database.put(still);
    alias(still, 2);
    const video = await storedVideo();
    alias(video, 3);

    const outcome = await backfillVideoPosters(
      {
        ...posterDeps({
          readFacts: async () => {
            throw new Error("no stream");
          },
        }),
        aliases,
      },
      { limit: 24 },
    );
    expect(outcome).toMatchObject({ scanned: 1, written: 0, complete: true });
  });
});
