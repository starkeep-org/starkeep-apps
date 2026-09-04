/**
 * What one page of the library says about a record, and to whom.
 *
 * Three questions share a tile and have three different answers, which is the
 * whole reason this file exists: *what can an `<Image>` paint*, *are the bytes
 * on this device*, and *what can a video player open*. They used to be one
 * field, and collapsing them is what made the viewer hand a video's
 * `content://` URI to an `<Image>` and draw a blank rectangle.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createDataRecord, createHLCClock, type DataRecord } from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter } from "@starkeep/storage-adapter";
import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { listLibrary, summarizeLibrary, type LibraryDeps } from "../src/library";

const clock = createHLCClock({ nodeId: "phone" });

let database: MockDatabaseAdapter;
/** Keys whose bytes this node can name a file for. */
let held: Set<string>;

/**
 * Object storage narrowed to the one call the library makes.
 *
 * `localFileUriFor` is the whole of the port here: on this node it is the
 * overlay's answer, covering both a camera-roll asset behind an alias and a
 * blob fetched from the cloud. Which of the two a key is does not change what
 * the library does with the answer, so the fake does not model the difference.
 */
const objectStorage = {
  localFileUriFor: (key: string) => (held.has(key) ? `file:///objects/${key}` : null),
} as unknown as ObjectStorageAdapter;

/** Keys the motion index reports a clip inside. */
let motionKeys: Set<string>;

/**
 * The motion index narrowed to the one call the library makes.
 *
 * Only `withMotion` is modelled, because only `withMotion` is reached from here
 * — a grid asks which of a page's stills hold a clip and never asks where the
 * clip is. The rest of the port throws, so a future caller that starts needing
 * more fails loudly rather than reading a fake zero.
 */
function motionIndex(): LibraryDeps["motionIndex"] {
  return {
    withMotion: (keys) => new Set([...keys].filter((key) => motionKeys.has(key))),
    get: () => {
      throw new Error("the library does not ask where the clip is");
    },
    scanned: () => {
      throw new Error("the library does not ask whether anything looked");
    },
    record: () => {
      throw new Error("the library does not write to the index");
    },
    scannedFrom: () => {
      throw new Error("the library does not read the marker");
    },
    markScannedFrom: () => {
      throw new Error("the library does not write the marker");
    },
  };
}

function deps(): LibraryDeps {
  return { database, objectStorage, aliases: null, motionIndex: motionIndex() };
}

let seq = 0;
async function seed(type: string, options?: { readonly bytesHere?: boolean }): Promise<DataRecord> {
  seq += 1;
  const record = createDataRecord(
    {
      type,
      originAppId: "photos",
      contentHash: String(seq).padStart(64, "0"),
      objectStorageKey: `shared/${type.split("/")[0]}/${seq}`,
      sizeBytes: 1024,
      originalFilename: `file-${seq}`,
    },
    clock,
  );
  await database.put(record);
  if (options?.bytesHere !== false) held.add(record.objectStorageKey!);
  return record;
}

beforeEach(async () => {
  database = new MockDatabaseAdapter();
  await database.init();
  held = new Set();
  motionKeys = new Set();
  seq = 0;
});

describe("playbackUri", () => {
  it("names the video's own bytes when they are on this device", async () => {
    const record = await seed("video/mp4");

    const page = await listLibrary(deps(), { limit: 10 });

    expect(page.items[0]!.playbackUri).toBe(`file:///objects/${record.objectStorageKey}`);
  });

  it("is null for a video whose bytes are not here", async () => {
    // An elided clip. There is a record and there is nothing to play, and the
    // viewer's fetch control is what exists for it.
    await seed("video/mp4", { bytesHere: false });

    const page = await listLibrary(deps(), { limit: 10 });

    expect(page.items[0]!.playbackUri).toBeNull();
    expect(page.items[0]!.bytesHere).toBe(false);
  });

  it("is null for a still, whose bytes no player should be handed", async () => {
    await seed("image/jpeg");

    const page = await listLibrary(deps(), { limit: 10 });

    expect(page.items[0]!.playbackUri).toBeNull();
    // `uri` is null too, and for an unrelated reason: the list paints rungs and
    // this record has none. The pair being null together is what makes the two
    // fields worth asserting separately — see `bytesHere`, which is true.
    expect(page.items[0]!.bytesHere).toBe(true);
  });

  it("paints no video with no poster, and still plays it", async () => {
    // **A knowing loss, recorded here so it cannot be mistaken for the bug it
    // replaced.** `expo-image` does decode a video's first frame — settled on a
    // handset 2026-09-02 — and the list used to show one. It stopped when the
    // list stopped painting originals, because that frame comes out of
    // `MediaMetadataRetriever` and is the most expensive decode on the surface.
    //
    // The consequence is sharper for a clip than for a still: this device
    // derives no video rungs at all, so a phone-only library's clips paint their
    // ThumbHash until a poster arrives by sync, where a still is derived within
    // seconds of being looked at.
    //
    // Playback is untouched, which is the assertion that matters most here — a
    // tile that paints nothing must still open and play.
    await seed("video/mp4");

    const item = (await listLibrary(deps(), { limit: 10 })).items[0]!;

    expect(item.uri).toBeNull();
    expect(item.bytesHere).toBe(true);
    expect(item.playbackUri).not.toBeNull();
  });
});

describe("hasMotion", () => {
  it("marks a still the index found a clip inside", async () => {
    const record = await seed("image/jpeg");
    motionKeys.add(record.objectStorageKey!);

    const item = (await listLibrary(deps(), { limit: 10 })).items[0]!;

    expect(item.hasMotion).toBe(true);
  });

  it("is false for an ordinary photograph", async () => {
    await seed("image/jpeg");

    const item = (await listLibrary(deps(), { limit: 10 })).items[0]!;

    expect(item.hasMotion).toBe(false);
  });

  it("is false when this node has no index, rather than throwing", async () => {
    // A node with no device media has no index. The tile marks nothing, which
    // is the same answer it gives for a photograph nobody has scanned.
    const record = await seed("image/jpeg");
    motionKeys.add(record.objectStorageKey!);

    const page = await listLibrary(
      { database, objectStorage, aliases: null, motionIndex: null },
      { limit: 10 },
    );

    expect(page.items[0]!.hasMotion).toBe(false);
  });

  it("never asks the index about a video", async () => {
    // A Motion Photo is an image record. Asking about clips would put every
    // video on the page into a query that cannot match, and would let a video
    // tile draw a mark the grid has already given a different corner meaning.
    const asked: string[][] = [];
    const record = await seed("video/mp4");
    motionKeys.add(record.objectStorageKey!);

    const page = await listLibrary(
      {
        database,
        objectStorage,
        aliases: null,
        motionIndex: {
          ...motionIndex()!,
          withMotion: (keys) => {
            asked.push([...keys]);
            return new Set();
          },
        },
      },
      { limit: 10 },
    );

    expect(asked).toEqual([[]]);
    expect(page.items[0]!.hasMotion).toBe(false);
  });
});

describe("durationMs", () => {
  it("carries the video table's duration onto the item", async () => {
    const record = await seed("video/mp4");
    await database.putMetadata("video", { recordId: record.id, duration_ms: 42_000 });

    const page = await listLibrary(deps(), { limit: 10 });

    expect(page.items[0]!.durationMs).toBe(42_000);
  });

  it("is null for a video nothing has measured", async () => {
    // A clip whose bytes arrived by sync from a node that recorded no duration.
    // `formatDuration` renders this as the word "video", not as `0:00`.
    await seed("video/mp4");

    const page = await listLibrary(deps(), { limit: 10 });

    expect(page.items[0]!.durationMs).toBeNull();
  });

  it("is null for a still, whose table has no such column", async () => {
    await seed("image/jpeg");

    const page = await listLibrary(deps(), { limit: 10 });

    expect(page.items[0]!.durationMs).toBeNull();
  });

  it("asks the video table once for the page rather than once per tile", async () => {
    // One query per page, for the same reason the rendition resolution is
    // batched: a page of sixty tiles must not become sixty round trips.
    const calls: Array<{ typeId: string; count: number }> = [];
    await seed("video/mp4");
    await seed("video/mp4");
    await seed("image/jpeg");
    const watched = {
      ...deps(),
      database: Object.assign(Object.create(Object.getPrototypeOf(database)), database, {
        getMetadataByIds: async (typeId: string, ids: Parameters<typeof database.getMetadataByIds>[1]) => {
          calls.push({ typeId, count: ids.length });
          return database.getMetadataByIds(typeId, ids);
        },
      }) as MockDatabaseAdapter,
    };

    await listLibrary(watched, { limit: 10 });

    expect(calls.filter((c) => c.typeId === "video")).toEqual([{ typeId: "video", count: 2 }]);
  });

  it("asks nothing at all for a page holding no video", async () => {
    const calls: string[] = [];
    await seed("image/jpeg");
    const watched = {
      ...deps(),
      database: Object.assign(Object.create(Object.getPrototypeOf(database)), database, {
        getMetadataByIds: async (typeId: string, ids: Parameters<typeof database.getMetadataByIds>[1]) => {
          calls.push(typeId);
          return database.getMetadataByIds(typeId, ids);
        },
      }) as MockDatabaseAdapter,
    };

    await listLibrary(watched, { limit: 10 });

    expect(calls).not.toContain("video");
  });
});

/**
 * What order the grid puts records in, and whether every one of them is reachable.
 *
 * The reported symptom that produced all of this: a node holding 510 records
 * drew 60 of them, ordered by when each entered the node, and offered no control
 * that reached the rest. Import walks the camera roll oldest-first, so a tap on
 * "Add photos from this device" pushed the most recent photographs off the
 * bottom of the grid — the control that promises to make pictures appear was the
 * mechanism that made them disappear.
 */
describe("the order the library is read in", () => {
  /** Give a record a capture time, the way import now does from the header. */
  async function captured(record: DataRecord, at: string): Promise<void> {
    await database.putMetadata("image", { recordId: record.id, captured_at: at });
  }

  it("orders by when the picture was taken, not by when it was imported", async () => {
    // Written in the order import would mint them — oldest photograph last —
    // so ordering by `created_at` and ordering by capture time disagree.
    const july = await seed("image/jpeg");
    const august = await seed("image/jpeg");
    const june = await seed("image/jpeg");
    await captured(july, "2026-07-01T12:00:00");
    await captured(august, "2026-08-01T12:00:00");
    await captured(june, "2026-06-01T12:00:00");

    const page = await listLibrary(deps(), { limit: 10 });

    expect(page.items.map((i) => i.record.id)).toEqual([august.id, july.id, june.id]);
  });

  it("puts a record with no capture time after every record that has one", async () => {
    // The state the library is in until the EXIF backfill has run, and the
    // reason `captured_at` is a separate sort key rather than a `COALESCE` onto
    // `created_at`: the two are not comparable, so the unknowns get a bucket
    // rather than an invented position among the knowns.
    const known = await seed("image/jpeg");
    const unknown = await seed("image/jpeg");
    await captured(known, "2020-01-01T00:00:00");

    const page = await listLibrary(deps(), { limit: 10 });

    expect(page.items.map((i) => i.record.id)).toEqual([known.id, unknown.id]);
  });

  it("reaches every record by paging, without repeating or skipping one", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const record = await seed("image/jpeg");
      await captured(record, `2026-01-01T00:00:${String(i).padStart(2, "0")}`);
      ids.push(record.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await listLibrary(deps(), {
        limit: 6,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.items.map((i) => i.record.id));
      if (!result.hasMore || !result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen).toEqual([...ids].reverse());
  });

  it("pages across the boundary between the known and the unknown", async () => {
    // The boundary is where a keyset cursor over a nullable key gets it wrong:
    // the null bucket ties on the sort key, so only the id tiebreaker separates
    // its rows, and a cursor that cannot express "inside the nulls" either
    // repeats the bucket forever or skips all but one of it.
    for (let i = 0; i < 4; i += 1) {
      const record = await seed("image/jpeg");
      await captured(record, `2026-02-0${i + 1}T00:00:00`);
    }
    for (let i = 0; i < 4; i += 1) await seed("image/jpeg");

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await listLibrary(deps(), { limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...result.items.map((i) => i.record.id));
      if (!result.hasMore || !result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  });
});

describe("summarizeLibrary", () => {
  it("counts every record, not just the ones one page holds", async () => {
    for (let i = 0; i < 12; i += 1) await seed("image/jpeg");

    const summary = await summarizeLibrary(deps());

    // The number used to come from walking the whole library through the
    // pagination cursor, so it depended on the very thing it is meant to be
    // independent of.
    expect(summary.records).toBe(12);
  });

  it("does not count renditions, which the grid does not show either", async () => {
    const parent = await seed("image/jpeg");
    const rendition = await seed("image/avif");
    await database.upsertLabels([
      {
        recordId: rendition.id,
        appId: "photos",
        key: "rendition",
        value: "image-thumb",
        recordType: rendition.type,
        hlc: clock.now(),
      },
    ]);

    const summary = await summarizeLibrary(deps());
    const page = await listLibrary(deps(), { limit: 10 });

    // The count and the grid have to agree about what a record is: five
    // renditions per photograph would otherwise report six times the library.
    expect(summary.records).toBe(1);
    expect(page.items.map((i) => i.record.id)).toEqual([parent.id]);
  });
});

