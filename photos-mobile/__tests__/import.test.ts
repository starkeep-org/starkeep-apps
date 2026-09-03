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
import { createHLCClock, dataRecordObjectKey, type StarkeepId } from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, type RawDatabase } from "@starkeep/storage-adapter";
import { createSqliteMediaAliasStore, type MediaAliasStore } from "../src/media/media-alias";
import {
  backfillImageExif,
  backfillThumbHashes,
  backfillVideoDurations,
  importDeviceMedia,
  importNullModified,
  IMPORTABLE_MEDIA_TYPES,
  noYield,
  MAX_INLINE_READ_BYTES,
  type HashBytes,
} from "../src/media/import";
import {
  createSqliteImportCursorStore,
  VIDEO_DURATION_CURSOR_TABLE,
} from "../src/media/import-cursor";
import {
  createSqliteMotionIndexStore,
  type MotionIndexStore,
} from "../src/media/motion-index";
import { MediaQueryTimeout } from "../src/media/device-library";
import type {
  AssetMetadataLike,
  DeviceMediaModule,
  MediaQuery,
} from "../src/media/device-library";
import { fakeExpoFs } from "./helpers/fake-expo-fs";
import { jpegWithExif } from "./helpers/jpeg-exif";

/** node:crypto standing in for the phone's native digest — same bytes either way. */
const nodeHash: HashBytes = async (bytes) => createHash("sha256").update(bytes).digest("hex");

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

/** What the last query asked the media store to sort by. */
let lastOrderBy: { key: string; ascending?: boolean } | null = null;
/** How many rows the last query actually returned, before import looked at any. */
let lastReturnedRows = 0;

/**
 * A media store whose asset ids are already `content://` URIs, as Android's are.
 *
 * **This fake applies the filter, the sort and the limit rather than ignoring
 * them**, which the earlier version did. Ignoring them was harmless while the
 * only question was what import did with the rows it was handed. It stopped
 * being harmless once the rows themselves became the thing under test: the
 * whole point of the watermark is that the media store never produces a row for
 * an asset already imported, and a fake that returns everything regardless
 * cannot tell a working filter from an absent one.
 */
function fakeMedia(rows: AssetMetadataLike[]): DeviceMediaModule {
  const build = (state: {
    order: { key: string; ascending?: boolean } | null;
    floor: { field: string; value: number } | null;
    kinds: readonly string[] | null;
    limit: number | null;
  }): MediaQuery => ({
    orderBy: (sort) => {
      lastOrderBy = sort;
      return build({ ...state, order: sort });
    },
    limit: (count) => build({ ...state, limit: count }),
    gte: (field, value) => build({ ...state, floor: { field, value } }),
    within: (_field, values) => build({ ...state, kinds: values }),
    exeForMetadata: async () => {
      const key = (row: AssetMetadataLike, field: string): number =>
        (field === "creationTime" ? row.creationTime : row.modificationTime) ?? 0;
      let out = [...rows];
      if (state.floor) {
        const floor = state.floor;
        out = out.filter((row) => key(row, floor.field) >= floor.value);
      }
      if (state.kinds) {
        const kinds = state.kinds;
        out = out.filter((row) => kinds.includes(row.mediaType));
      }
      if (state.order) {
        const order = state.order;
        out.sort((a, b) =>
          order.ascending === true
            ? key(a, order.key) - key(b, order.key)
            : key(b, order.key) - key(a, order.key),
        );
      }
      if (state.limit !== null) out = out.slice(0, state.limit);
      lastReturnedRows = out.length;
      return out;
    },
  });
  const query = (): MediaQuery =>
    build({ order: null, floor: null, kinds: null, limit: null });
  return {
    getPermissions: async () => ({ granted: true, canAskAgain: true }),
    requestPermissions: async () => ({ granted: true, canAskAgain: true }),
    newQuery: query,
    uriFor: async (id) => id,
  };
}

/** An import watermark held in memory, with the store's monotonic guarantee. */
function fakeCursor(initial: number | null = null) {
  let value = initial;
  return {
    store: {
      get: () => value,
      set: (next: number) => {
        value = next;
      },
    },
    get value(): number | null {
      return value;
    },
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

function deps(rows: AssetMetadataLike[] = [asset({ id: URI_1 })]) {
  return {
    media: fakeMedia(rows),
    aliases,
    database,
    clock: createHLCClock({ nodeId: "phone" }),
    fs: fs.fs,
    hash: nodeHash,
    yieldToUi: () => Promise.resolve(),
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

describe("content:// assets, which cannot be streamed", () => {
  it("imports one anyway", async () => {
    // The regression this exists for: `File.readableStream()` throws for a
    // MediaStore URI, because `openHandle` has no `ContentProviderFile` branch.
    // Every asset on a real handset failed to import while every test passed,
    // because the fake streamed content URIs happily. It no longer does.
    const outcome = await importDeviceMedia(deps(), { limit: 10 });
    expect(outcome.failures).toEqual([]);
    expect(outcome.imported).toBe(1);
  });

  it("hashes it identically to the same bytes in a file", async () => {
    // The fallback path must not change the digest — a content-addressed key
    // that depended on how the bytes were read would silently stop matching
    // the same photo synced from a laptop.
    const outcome = await importDeviceMedia(deps(), { limit: 10 });
    expect(outcome.records[0]!.contentHash).toBe(
      createHash("sha256").update(PHOTO).digest("hex"),
    );
  });

  it("defers an asset too large to hold in memory rather than trying", async () => {
    // Materialising a 4K video is the OOM streaming exists to prevent, and a
    // named limit beats a process death.
    putAsset(URI_1, PHOTO);
    const huge = {
      ...deps(),
      fs: {
        ...fs.fs,
        file: (p: string) => ({ ...fs.fs.file(p), size: MAX_INLINE_READ_BYTES + 1 }),
      },
    };

    const outcome = await importDeviceMedia(huge, { limit: 10 });

    expect(outcome.imported).toBe(0);
    expect(outcome.failures[0]!.reason).toMatch(/larger than this device can hash/);
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
    // The reason travels with the failure. A count on its own is what made a
    // total import failure undiagnosable from the screen.
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]!.assetId).toBe(gone);
    expect(outcome.failures[0]!.reason).toBeTruthy();
  });
});

/**
 * Dimensions at import.
 *
 * The claim is narrow and load-bearing: an imported record carries the pixel
 * dimensions the media store already reported, in the category table every
 * reader looks in. Without them variant resolution has no applicable set, so
 * the phone cannot name the rung a tile should have and the cloud cannot tell
 * "this original has no renditions" from "this original has no dimensions".
 */
describe("dimensions", () => {
  it("records the media store's dimensions against the imported record", async () => {
    const outcome = await importDeviceMedia(deps(), { limit: 10 });
    const record = outcome.records[0]!;

    // Keyed by category, which is what `resolveLibraryRenditions` reads. A row
    // filed under `image/jpeg` would be invisible to it while looking present
    // in the database, so the table it lands in is the assertion.
    const row = await database.getMetadata("image", record.id);
    expect(row).toMatchObject({ width: 4032, height: 3024 });
  });

  it("writes the row before the record, so no sync round can cut between them", async () => {
    // A metadata row reaches a peer only as a passenger on its record, read
    // when a round is cut. Written after `put`, the dimensions would be absent
    // from any round that cut in the gap and nothing would offer them again.
    const order: string[] = [];
    const watched = {
      ...deps(),
      database: Object.assign(Object.create(Object.getPrototypeOf(database)), database, {
        putMetadata: async (t: string, r: Parameters<typeof database.putMetadata>[1]) => {
          order.push("metadata");
          return database.putMetadata(t, r);
        },
        put: async (r: Parameters<typeof database.put>[0]) => {
          order.push("record");
          return database.put(r);
        },
      }),
    };

    await importDeviceMedia(watched, { limit: 10 });

    expect(order).toEqual(["metadata", "record"]);
  });

  it("writes nothing for an asset the store could not measure", async () => {
    // A width with no height is still unorderable, and it would read as a known
    // value to everything downstream. Half a pair is worse than none.
    const d = {
      ...deps(),
      media: fakeMedia([asset({ id: URI_1, width: 4032, height: null })]),
    };

    const outcome = await importDeviceMedia(d, { limit: 10 });

    expect(outcome.imported).toBe(1);
    expect(await database.getMetadata("image", outcome.records[0]!.id)).toBeNull();
  });

  it("records a video's duration, in the video table", async () => {
    // The fact that makes a library tile able to say "0:42" rather than "video".
    // The media store reports it on the row import already reads, so it costs
    // one column and no decode.
    const d = {
      ...deps(),
      media: fakeMedia([
        asset({ id: URI_1, filename: "VID_0007.mp4", mediaType: "video", duration: 42_000 }),
      ]),
    };

    const outcome = await importDeviceMedia(d, { limit: 10 });

    const row = await database.getMetadata("video", outcome.records[0]!.id);
    expect(row).toMatchObject({ width: 4032, height: 3024, duration_ms: 42_000 });
  });

  it("writes no duration for a still, whose table has no such column", async () => {
    const outcome = await importDeviceMedia(deps(), { limit: 10 });
    const row = await database.getMetadata("image", outcome.records[0]!.id);
    expect(row).not.toHaveProperty("duration_ms");
  });

  it("writes no duration the store did not measure", async () => {
    // Null and zero both mean "not known" — the store's own mappers answer null
    // for an unmeasurable asset — and a zero written as a value would make a
    // tile claim a zero-length clip, which describes a broken file.
    for (const duration of [null, 0]) {
      const fresh = new MockDatabaseAdapter();
      await fresh.init();
      const d = {
        ...deps(),
        database: fresh,
        media: fakeMedia([
          asset({ id: URI_1, filename: "VID_0008.mp4", mediaType: "video", duration }),
        ]),
      };

      const outcome = await importDeviceMedia(d, { limit: 10 });

      const row = await fresh.getMetadata("video", outcome.records[0]!.id);
      expect(row).toMatchObject({ width: 4032, height: 3024 });
      expect(row).not.toHaveProperty("duration_ms");
    }
  });

  it("still writes a duration for a clip the store could not measure the frame of", async () => {
    // Dimensions and duration are separate facts, and the pair guard must not
    // suppress the one the store did report. Before duration existed this
    // function returned early on a missing dimension pair, which would have made
    // an unmeasured frame size cost the length as well.
    const d = {
      ...deps(),
      media: fakeMedia([
        asset({
          id: URI_1,
          filename: "VID_0009.mp4",
          mediaType: "video",
          width: null,
          height: null,
          duration: 7_000,
        }),
      ]),
    };

    const outcome = await importDeviceMedia(d, { limit: 10 });

    const row = await database.getMetadata("video", outcome.records[0]!.id);
    expect(row).toMatchObject({ duration_ms: 7_000 });
    expect(row).not.toHaveProperty("width");
  });

  it("writes nothing for a record with no metadata table", async () => {
    // `other` is the terminal category and has no table. The import still
    // succeeds — an unrecognised file is a record like any other.
    const d = {
      ...deps(),
      media: fakeMedia([asset({ id: URI_1, filename: "notes.unknownext" })]),
    };

    const outcome = await importDeviceMedia(d, { limit: 10 });

    expect(outcome.imported).toBe(1);
    expect(outcome.records[0]!.type).toBe("other/other");
    expect(await database.getMetadata("other", outcome.records[0]!.id)).toBeNull();
  });
});


describe("which assets import can reach", () => {
  it("orders by modification time, never by the nullable creation time", async () => {
    // The media store fills `creationTime` from EXIF, so an image carrying none
    // has no value at all — and a null sort key behind a limit is not "last",
    // it is unreachable, because every pass asks the same question and gets the
    // same answer. An image saved from a messaging app or copied onto the
    // device would never be imported, on any pass, foreground or background.
    await importDeviceMedia(deps(), { limit: 20 });

    expect(lastOrderBy).toEqual({ key: "modificationTime", ascending: false });
  });

  it("imports an asset the media store has no creation time for", async () => {
    const undated = "content://media/external/images/media/999";
    putAsset(undated, PHOTO);

    const outcome = await importDeviceMedia(
      deps([asset({ id: undated, creationTime: null })]),
      { limit: 20 },
    );

    expect(outcome.imported).toBe(1);
    expect(outcome.failed).toBe(0);
  });
});

describe("importing against a watermark", () => {
  /** Three assets a second apart, oldest first, all readable. */
  function roll(): AssetMetadataLike[] {
    const rows: AssetMetadataLike[] = [];
    for (const [i, at] of [1_000_000, 2_000_000, 3_000_000].entries()) {
      const uri = `content://media/external/images/media/${10 + i}`;
      putAsset(uri, new Uint8Array(PHOTO.map((b) => (b + i) % 256)));
      rows.push(asset({ id: uri, modificationTime: at, creationTime: at }));
    }
    return rows;
  }

  it("imports nothing on a first look, and records where 'now' is", async () => {
    // A node that has never imported must not spend its first background window
    // hashing a camera roll: on the handset that window was stopped by Android
    // mid-call and the process frozen holding it. Establishing the watermark
    // costs one row's worth of media-store probe.
    const cursor = fakeCursor();

    const outcome = await importDeviceMedia(
      { ...deps(roll()), importCursor: cursor.store },
      { limit: 20 },
    );

    expect(outcome.cursorSeeded).toBe(true);
    expect(outcome.imported).toBe(0);
    expect(cursor.value).toBe(3_000_000);
  });

  it("asks the media store for one row when seeding, not the whole window", async () => {
    // The cost being fixed is the *query*, not the loop after it:
    // `exeForMetadata()` probes every row it returns, inside the media store,
    // before import can look at any of them.
    const cursor = fakeCursor();

    await importDeviceMedia({ ...deps(roll()), importCursor: cursor.store }, { limit: 20 });

    expect(lastReturnedRows).toBe(1);
  });

  it("imports only what has appeared since the watermark", async () => {
    // Between the second and third assets, so the floor sits clear of both the
    // overlap window and the assets already behind it.
    const cursor = fakeCursor(2_500_000);

    const outcome = await importDeviceMedia(
      { ...deps(roll()), importCursor: cursor.store },
      { limit: 20 },
    );

    expect(outcome.imported).toBe(1);
    expect(lastReturnedRows).toBe(1);
    expect(cursor.value).toBe(3_000_000);
  });

  it("costs one row rather than a whole window when nothing has changed", async () => {
    // The steady state on a phone in a pocket, and the whole point of the
    // watermark: the daily allowance is ten minutes of execution, and a query
    // over twenty assets spent all of it on a roll with one new photograph.
    //
    // Not *zero* rows, and the difference is worth asserting rather than
    // rounding off. `CURSOR_OVERLAP_MS` deliberately re-offers the last second
    // below the watermark so a burst sharing that second cannot be lost, so a
    // quiet roll returns the overlap and settles it with an alias lookup.
    const rows = roll();
    const cursor = fakeCursor(500_000);
    await importDeviceMedia({ ...deps(rows), importCursor: cursor.store }, { limit: 20 });

    const second = await importDeviceMedia(
      { ...deps(rows), importCursor: cursor.store },
      { limit: 20 },
    );

    expect(lastReturnedRows).toBe(1);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("walks oldest first once it has a watermark", async () => {
    // A fixed window taken from the *newest* end cannot drain a backlog:
    // advancing the watermark to the newest asset skips everything the limit
    // cut off, and advancing it to the oldest re-offers the batch forever.
    const cursor = fakeCursor(500_000);

    await importDeviceMedia({ ...deps(roll()), importCursor: cursor.store }, { limit: 20 });

    expect(lastOrderBy).toEqual({ key: "modificationTime", ascending: true });
  });

  it("drains a backlog larger than one window without losing an asset", async () => {
    const rows = roll();
    const cursor = fakeCursor(500_000);

    const first = await importDeviceMedia(
      { ...deps(rows), importCursor: cursor.store },
      { limit: 2 },
    );
    const second = await importDeviceMedia(
      { ...deps(rows), importCursor: cursor.store },
      { limit: 2 },
    );

    expect(first.imported).toBe(2);
    expect(second.imported).toBe(1);
    expect(cursor.value).toBe(3_000_000);
  });

  it("keeps an asset sharing its second with the last one imported", async () => {
    // `DATE_MODIFIED` is whole seconds, so a burst carries one value for every
    // asset in it. A strict floor at the watermark would drop the rest of the
    // burst permanently — the same shape of defect as ordering on a nullable
    // column, which cost this app a whole class of image once already.
    const shared = 2_000_000;
    const late = "content://media/external/images/media/77";
    putAsset(late, new Uint8Array(PHOTO.map((b) => (b + 9) % 256)));
    const rows = [
      asset({ id: URI_1, modificationTime: shared }),
      asset({ id: late, modificationTime: shared }),
    ];
    const cursor = fakeCursor(shared);

    const outcome = await importDeviceMedia(
      { ...deps(rows), importCursor: cursor.store },
      { limit: 20 },
    );

    expect(outcome.imported).toBe(2);
  });

  it("moves past an asset it can never read", async () => {
    // Holding the watermark back would let one unreadable asset pin the floor
    // forever, so every later window asks for it and everything newer — the
    // result set grows without bound, which is the failure the watermark exists
    // to prevent.
    const rows = [
      asset({ id: URI_1, modificationTime: 1_000_000 }),
      asset({ id: "content://media/external/images/media/missing", modificationTime: 2_000_000 }),
      asset({ id: "content://media/external/images/media/10", modificationTime: 3_000_000 }),
    ];
    putAsset("content://media/external/images/media/10", PHOTO);
    const cursor = fakeCursor(500_000);

    const outcome = await importDeviceMedia(
      { ...deps(rows), importCursor: cursor.store },
      { limit: 20 },
    );

    expect(outcome.failed).toBe(1);
    expect(cursor.value).toBe(3_000_000);
  });

  it("keeps the watermark it reached when the window closes early", async () => {
    // Written per asset rather than once at the end, because the process
    // running this loop is the one Android freezes and kills mid-call.
    const rows = roll();
    const cursor = fakeCursor(500_000);
    let seen = 0;
    const signal = {
      get aborted(): boolean {
        return seen++ >= 2;
      },
    };

    await importDeviceMedia(
      { ...deps(rows), importCursor: cursor.store },
      { limit: 20, signal },
    );

    expect(cursor.value).toBe(2_000_000);
  });

  it("leaves the foreground control walking the whole roll", async () => {
    // The split is the point. A watermark is right for work that runs every
    // fifteen minutes forever and wrong for a person tapping "Add photos" to
    // backfill a library that predates this node.
    const outcome = await importDeviceMedia(deps(roll()), { limit: 20 });

    expect(outcome.cursorSeeded).toBeUndefined();
    expect(outcome.imported).toBe(3);
    expect(lastOrderBy).toEqual({ key: "modificationTime", ascending: false });
  });
});

describe("what import refuses to be offered", () => {
  it("never sees a file the media store indexed that is neither image nor video", async () => {
    // The row that stalled a real handset: an entry under another app's
    // `Android/media/.../. trash/` directory, carrying `media_type = 0`, a null
    // MIME type, a null size and no extension. `exeForMetadata()` runs over
    // `MediaStore.Files`, so nothing excluded it, and import has nothing
    // sensible to do with it — `typeOf` falls back to `other/binary` and the
    // bytes are not this app's to read.
    const trash = "content://media/external/file/1000008916";
    putAsset(trash, PHOTO);
    const rows = [
      asset({ id: URI_1, modificationTime: 1_000_000 }),
      asset({
        id: trash,
        filename: "e6477252-503e-46b7-a645-eef7e7b3c50f",
        mediaType: "unknown",
        width: null,
        height: null,
        modificationTime: 2_000_000,
      }),
    ];
    const cursor = fakeCursor(500_000);

    const outcome = await importDeviceMedia(
      { ...deps(rows), importCursor: cursor.store },
      { limit: 20 },
    );

    expect(lastReturnedRows).toBe(1);
    expect(outcome.imported).toBe(1);
    expect(outcome.records[0]!.originalFilename).toBe("IMG_0001.jpg");
  });

  it("asks for images and video, and nothing else", async () => {
    // Audio included in the exclusion deliberately: this is a photos app, and a
    // record it cannot show is a record it should not mint.
    expect(IMPORTABLE_MEDIA_TYPES).toEqual(["image", "video"]);
  });
});

describe("importing where no JS timer will ever fire", () => {
  it("finishes the batch when the yield is timer-free", async () => {
    // React Native runs no JS timers in a headless context. The default yield
    // is a `setTimeout`, so a background window using it hangs forever on the
    // first asset it actually wants to import — measured on a Pixel 5, where
    // timers armed at 5 s and 20 s had not fired three minutes later.
    const rows = [
      asset({ id: URI_1, modificationTime: 1_000_000 }),
      asset({ id: "content://media/external/images/media/10", modificationTime: 2_000_000 }),
    ];
    putAsset("content://media/external/images/media/10", PHOTO);
    const cursor = fakeCursor(500_000);

    const outcome = await importDeviceMedia(
      { ...deps(rows), importCursor: cursor.store, yieldToUi: noYield },
      { limit: 20 },
    );

    expect(outcome.imported).toBe(2);
  });

  it("hangs on the first import when the yield needs a timer that never fires", async () => {
    // The failure itself, so the fix above is guarding something real rather
    // than restating itself. A yield that never resolves must never resolve the
    // pass either — and the import loop awaits it before the first `importOne`.
    const neverFires = () => new Promise<void>(() => undefined);
    const cursor = fakeCursor(500_000);

    const pending = importDeviceMedia(
      {
        ...deps([asset({ id: URI_1, modificationTime: 1_000_000 })]),
        importCursor: cursor.store,
        yieldToUi: neverFires,
      },
      { limit: 20 },
    );
    const settled = await Promise.race([
      pending.then(() => "settled"),
      Promise.resolve().then(() => "still pending"),
    ]);

    expect(settled).toBe("still pending");
  });

  it("bounds the media store on the caller's timer rather than the platform's", async () => {
    // The deadline the background window relies on is only a deadline if the
    // timer behind it fires, and the platform's does not in a headless process.
    // Firing this one is what proves the injected timer reaches the query — a
    // pass that took `REAL_TIMERS` instead would still be hanging here.
    const armed: (() => void)[] = [];
    const timers = {
      setTimeout: (handler: () => void) => {
        armed.push(handler);
        return armed.length;
      },
      clearTimeout: () => undefined,
    };
    const hanging: DeviceMediaModule = {
      ...deps().media,
      newQuery: () => {
        const query: MediaQuery = {
          orderBy: () => query,
          limit: () => query,
          gte: () => query,
          within: () => query,
          exeForMetadata: () => new Promise(() => undefined),
        };
        return query;
      },
    };
    const cursor = fakeCursor(500_000);

    const pending = importDeviceMedia(
      { ...deps(), media: hanging, importCursor: cursor.store },
      { limit: 20, queryTimeoutMs: 30_000, timers },
    );
    armed.forEach((fire) => fire());

    await expect(pending).rejects.toThrow(MediaQueryTimeout);
  });
});

/**
 * Repairing the clips imported before a record carried a duration.
 *
 * The pass exists because re-importing cannot do it: `alreadyImported` skips an
 * asset whose media-store mtime is unchanged, and for these clips nothing about
 * the bytes changed — only what this node bothered to write about them.
 *
 * It walks a watermark rather than asking about the records it wants, because
 * the media store cannot be asked about specific asset ids: `AssetField` names
 * no id column, so there is no `id IN (…)`. What the walk buys is that every
 * row it pays for is a row it has not already considered, and a returned row is
 * the expensive thing here.
 */
describe("backfillVideoDurations", () => {
  const CLIP_A = "content://media/external/video/media/10";
  const CLIP_B = "content://media/external/video/media/11";

  function clip(id: string, overrides: Partial<AssetMetadataLike> = {}): AssetMetadataLike {
    return asset({
      id,
      filename: `${id.split("/").pop()}.mp4`,
      mediaType: "video",
      duration: 42_000,
      modificationTime: 1_700_000_000_000,
      ...overrides,
    });
  }

  /**
   * A clip imported the way it was before durations were written.
   *
   * Distinct bytes per clip, which is load-bearing rather than tidy: keys and
   * record ids are content-addressed, so three clips holding the same bytes are
   * one record with one alias.
   */
  async function importWithoutDuration(rows: AssetMetadataLike[]) {
    rows.forEach((row, index) => putAsset(row.id, new Uint8Array(400 + index).fill(index + 1)));
    const outcome = await importDeviceMedia(
      { ...deps(), media: fakeMedia(rows.map((r) => ({ ...r, duration: null }))) },
      { limit: 10 },
    );
    return outcome;
  }

  function backfillDeps(rows: AssetMetadataLike[]) {
    return {
      media: fakeMedia(rows),
      aliases,
      database,
      cursor: createSqliteImportCursorStore({
        db: rawDb(),
        table: VIDEO_DURATION_CURSOR_TABLE,
      }),
    };
  }

  it("writes the duration of a clip imported before one was recorded", async () => {
    const rows = [clip(CLIP_A)];
    const imported = await importWithoutDuration(rows);
    expect(await database.getMetadata("video", imported.records[0]!.id)).not.toHaveProperty(
      "duration_ms",
    );

    const outcome = await backfillVideoDurations(backfillDeps(rows), { limit: 10 });

    expect(outcome.written).toBe(1);
    expect(await database.getMetadata("video", imported.records[0]!.id)).toMatchObject({
      duration_ms: 42_000,
    });
  });

  it("reports itself complete once the roll is walked, so the caller stops", async () => {
    const rows = [clip(CLIP_A)];
    await importWithoutDuration(rows);
    expect(await backfillVideoDurations(backfillDeps(rows), { limit: 10 })).toMatchObject({
      complete: true,
    });
  });

  it("reports itself incomplete while a full batch keeps coming back", async () => {
    const rows = [clip(CLIP_A), clip(CLIP_B, { modificationTime: 1_700_000_001_000 })];
    await importWithoutDuration(rows);
    expect(await backfillVideoDurations(backfillDeps(rows), { limit: 2 })).toMatchObject({
      scanned: 2,
      complete: false,
    });
  });

  it("resumes from its watermark rather than re-offering what it settled", async () => {
    // The whole reason for the watermark: a returned row costs a media-store
    // probe whether or not this pass has anything to do with it.
    const CLIP_C = "content://media/external/video/media/12";
    const rows = [
      clip(CLIP_A),
      clip(CLIP_B, { modificationTime: 1_700_000_090_000 }),
      clip(CLIP_C, { modificationTime: 1_700_000_180_000 }),
    ];
    await importWithoutDuration(rows);
    const d = backfillDeps(rows);

    const first = await backfillVideoDurations(d, { limit: 2 });
    expect(first).toMatchObject({ scanned: 2, written: 2, complete: false });

    const second = await backfillVideoDurations(d, { limit: 2 });
    // Two rows: the boundary clip the one-second overlap deliberately re-offers,
    // and the one beyond it. The oldest clip is behind the watermark and is not
    // paid for again, which is the claim.
    expect(second).toMatchObject({ scanned: 2, written: 1, complete: false });

    // A full batch is never itself the end — the overlap guarantees the last row
    // comes back once — so completion is one more pass, which finds only that
    // boundary row and nothing to write.
    expect(await backfillVideoDurations(d, { limit: 2 })).toMatchObject({
      scanned: 1,
      written: 0,
      complete: true,
    });
  });

  it("cannot advance past a batch entirely inside the overlap window", async () => {
    // A named limitation rather than a surprise. The next query floors at the
    // watermark minus one second, so a `limit` filled entirely by clips sharing
    // the boundary second returns the same rows forever. It is bounded by how
    // many clips a camera can write inside one second, which is why the caller's
    // limit is twenty-five rather than one.
    const rows = [clip(CLIP_A), clip(CLIP_B)];
    await importWithoutDuration(rows);
    const d = backfillDeps(rows);

    await backfillVideoDurations(d, { limit: 1 });
    const second = await backfillVideoDurations(d, { limit: 1 });

    expect(second).toMatchObject({ scanned: 1, written: 0 });
  });

  it("writes nothing for a clip that already has a duration", async () => {
    const rows = [clip(CLIP_A)];
    putAsset(CLIP_A, new Uint8Array(400).fill(1));
    // Imported with the duration already recorded, which is every clip from now
    // on. The one-second overlap re-offers boundary rows on every pass, so this
    // is the ordinary case rather than an edge one.
    await importDeviceMedia({ ...deps(), media: fakeMedia(rows) }, { limit: 10 });

    expect(await backfillVideoDurations(backfillDeps(rows), { limit: 10 })).toMatchObject({
      scanned: 1,
      written: 0,
    });
  });

  it("leaves a clip with no alias alone", async () => {
    // Bytes that arrived by sync rather than by import. Nothing on this device
    // can answer how long they are, and a null duration renders as the word
    // "video" rather than as `0:00`.
    const rows = [clip(CLIP_A)];
    putAsset(CLIP_A, new Uint8Array(400).fill(1));

    expect(await backfillVideoDurations(backfillDeps(rows), { limit: 10 })).toMatchObject({
      scanned: 1,
      written: 0,
    });
  });

  it("writes nothing for a clip the store could not measure", async () => {
    const rows = [clip(CLIP_A, { duration: null })];
    await importWithoutDuration(rows);

    expect(await backfillVideoDurations(backfillDeps(rows), { limit: 10 })).toMatchObject({
      written: 0,
    });
  });

  it("never pays for a still", async () => {
    // Every returned row costs the media store's per-row probe, and a photograph
    // has no duration to repair. The filter is the whole economy of this pass.
    const rows = [clip(CLIP_A), asset({ id: URI_1 })];
    await importWithoutDuration(rows);

    const outcome = await backfillVideoDurations(backfillDeps(rows), { limit: 10 });

    expect(outcome.scanned).toBe(1);
  });
});

/**
 * Noticing the video inside a Motion Photo, at the one moment it is free.
 *
 * Android appends the clip inside the JPEG and describes where in XMP, so
 * nothing notices unless something looks — and a Motion Photo imported without
 * this is a still that silently lost its motion. The moment to look is the one
 * where the whole file is already in memory to be hashed.
 */
describe("the Motion Photo index", () => {
  const encoder = new TextEncoder();
  let motionIndex: MotionIndexStore;

  /** A minimal MP4: an `ftyp` box, which is what the validator looks for. */
  function fakeMp4(size: number): Uint8Array {
    const out = new Uint8Array(size);
    out.set([0x00, 0x00, 0x00, 0x18], 0);
    out.set(encoder.encode("ftyp"), 4);
    out.set(encoder.encode("mp42"), 8);
    return out;
  }

  /** A v1 Motion Photo: the offset is a length back from the end of the file. */
  function motionPhoto(clipSize = 256): Uint8Array {
    const xmp =
      `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
      `<rdf:RDF GCamera:MicroVideoOffset="${clipSize}"/></x:xmpmeta>`;
    const head = new Uint8Array(2 + xmp.length + 64);
    head.set([0xff, 0xd8], 0);
    head.set(encoder.encode(xmp), 2);
    const out = new Uint8Array(head.byteLength + clipSize);
    out.set(head, 0);
    out.set(fakeMp4(clipSize), head.byteLength);
    return out;
  }

  beforeEach(() => {
    motionIndex = createSqliteMotionIndexStore({ db: rawDb() });
  });

  it("records where the clip is, without writing the clip anywhere", async () => {
    putAsset(URI_1, motionPhoto());
    const before = [...fs.files.keys()];

    const outcome = await importDeviceMedia({ ...deps(), motionIndex }, { limit: 10 });

    const key = outcome.records[0]!.objectStorageKey!;
    expect(motionIndex.get(key)).toMatchObject({ mimeType: "video/mp4", length: 256 });
    // The whole decision, asserted over the filesystem's actual contents: the
    // motion is a property of bytes the record already holds, and nothing is
    // stored beside it.
    expect([...fs.files.keys()]).toEqual(before);
  });

  it("writes no row for an ordinary photograph", async () => {
    // A negative row per still would be a row per image record — sixty thousand
    // of them saying nothing. The marker is what makes their absence an answer.
    const outcome = await importDeviceMedia({ ...deps(), motionIndex }, { limit: 10 });
    expect(motionIndex.scanned(outcome.records[0]!.objectStorageKey!)).toBe(false);
  });

  it("marks when it started looking, before importing anything", async () => {
    await importDeviceMedia({ ...deps(), motionIndex }, { limit: 10 });
    // `deps()` freezes the clock, so this is the pass's own start rather than a
    // moment somewhere inside it — which is what makes every record it minted
    // covered by the marker.
    expect(motionIndex.scannedFrom()).toBe(1_700_000_500_000);
  });

  it("leaves the marker alone on a later pass", async () => {
    await importDeviceMedia({ ...deps(), motionIndex }, { limit: 10 });
    await importDeviceMedia(
      { ...deps(), motionIndex, now: () => 1_800_000_000_000 },
      { limit: 10 },
    );
    expect(motionIndex.scannedFrom()).toBe(1_700_000_500_000);
  });

  it("does not scan a video", async () => {
    // A video carries no such XMP, and the scan is a text search over the first
    // 512 KB that cannot match.
    putAsset(URI_1, motionPhoto());
    const d = {
      ...deps(),
      motionIndex,
      media: fakeMedia([asset({ id: URI_1, filename: "VID_0001.mp4", mediaType: "video" })]),
    };

    const outcome = await importDeviceMedia(d, { limit: 10 });

    expect(motionIndex.scanned(outcome.records[0]!.objectStorageKey!)).toBe(false);
  });

  it("does not scan a still that is not a JPEG", async () => {
    // The format is Google's and it is defined over JPEG. A HEIC carrying these
    // bytes would still not be a Motion Photo.
    putAsset(URI_1, motionPhoto());
    const d = {
      ...deps(),
      motionIndex,
      media: fakeMedia([asset({ id: URI_1, filename: "IMG_0002.HEIC" })]),
    };

    const outcome = await importDeviceMedia(d, { limit: 10 });

    expect(motionIndex.scanned(outcome.records[0]!.objectStorageKey!)).toBe(false);
  });

  it("imports normally on a node with no index at all", async () => {
    // Absent means "do not look", which is the right default for a node with no
    // such table. It must not be the difference between importing and not.
    putAsset(URI_1, motionPhoto());
    const outcome = await importDeviceMedia(deps(), { limit: 10 });
    expect(outcome.imported).toBe(1);
  });
});

describe("what the header adds to a record", () => {
  /** The asset's bytes replaced with a JPEG carrying a real EXIF header. */
  function withHeader(fixture: Parameters<typeof jpegWithExif>[0]): void {
    putAsset(URI_1, jpegWithExif(fixture));
  }

  it("records the capture time and the orientation the header states", async () => {
    withHeader({ dateTimeOriginal: "2026:07:06 14:53:56", orientation: 6 });
    const outcome = await importDeviceMedia(deps(), { limit: 10 });

    const row = await database.getMetadata("image", outcome.records[0]!.id);
    expect(row).toMatchObject({ captured_at: "2026-07-06T14:53:56", orientation: 6 });
  });

  it("writes an orientation beside the dimensions, which is what makes them readable", async () => {
    // The media store's WIDTH/HEIGHT are the *stored* dimensions — Android does
    // not correct them for rotation, unlike the legacy `Asset` API's
    // `maybeRotateAssetSize`. Recording them with nothing beside them, which is
    // what this app did from `1ca50ea` until now, hands every consumer a
    // landscape box for a portrait photograph.
    withHeader({ orientation: 6 });
    const outcome = await importDeviceMedia(deps(), { limit: 10 });

    const row = await database.getMetadata("image", outcome.records[0]!.id);
    expect(row).toMatchObject({ width: 4032, height: 3024, orientation: 6 });
  });

  it("prefers the header's dimensions to the media store's", async () => {
    // They come from the same header as the orientation, so they cannot
    // disagree with it. The media store's columns stay the fallback.
    withHeader({ pixelWidth: 1024, pixelHeight: 768, orientation: 1 });
    const outcome = await importDeviceMedia(deps(), { limit: 10 });

    const row = await database.getMetadata("image", outcome.records[0]!.id);
    expect(row).toMatchObject({ width: 1024, height: 768 });
  });

  it("imports a photograph whose header says nothing, and writes neither column", async () => {
    // A screenshot. Absent is a state every reader already handles, so neither
    // column is defaulted — a zero orientation would claim knowledge, and an
    // invented capture time would sort the picture somewhere it does not belong.
    withHeader({});
    const outcome = await importDeviceMedia(deps(), { limit: 10 });

    expect(outcome.imported).toBe(1);
    const row = await database.getMetadata("image", outcome.records[0]!.id);
    expect(row?.["captured_at"]).toBeUndefined();
    expect(row?.["orientation"]).toBeUndefined();
  });

  it("imports a photograph whose header is corrupt", async () => {
    // Bytes that start like a JPEG and then are not one. The import must
    // succeed: a header this app cannot read is not a reason to refuse a file.
    const broken = new Uint8Array(3000);
    broken[0] = 0xff;
    broken[1] = 0xd8;
    broken[2] = 0xff;
    broken[3] = 0xe1;
    broken[4] = 0xff;
    broken[5] = 0xff;
    putAsset(URI_1, broken);

    const outcome = await importDeviceMedia(deps(), { limit: 10 });
    expect(outcome.imported).toBe(1);
    expect(outcome.failed).toBe(0);
  });

  it("does not read a header out of a video", async () => {
    // `readImageExif` walks a JPEG's segment chain; over a video's bytes it can
    // only fail, and paying for the scan to learn that is waste on the one file
    // kind where the bytes are largest.
    const clipUri = "content://media/external/video/media/9";
    putAsset(clipUri, PHOTO);
    const outcome = await importDeviceMedia(
      deps([asset({ id: clipUri, filename: "VID_0009.mp4", mediaType: "video", duration: 4200 })]),
      { limit: 10 },
    );

    const row = await database.getMetadata("video", outcome.records[0]!.id);
    expect(row).toMatchObject({ duration_ms: 4200 });
    expect(row?.["captured_at"]).toBeUndefined();
  });
});

describe("backfillImageExif", () => {
  /** A node that imported some stills before anything read a header. */
  async function importedWithoutExif(count: number): Promise<StarkeepId[]> {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      const uri = `content://media/external/images/media/${100 + i}`;
      putAsset(uri, jpegWithExif({ dateTimeOriginal: `2026:0${i + 1}:01 12:00:00`, orientation: 6 }));
      rows.push(asset({ id: uri, modificationTime: 1_700_000_000_000 + i * 1000 }));
    }
    const outcome = await importDeviceMedia(deps(rows), { limit: count });
    for (const record of outcome.records) {
      await database.deleteMetadata("image", record.id);
      // The state `1ca50ea` left records in: dimensions, and nothing else.
      await database.putMetadata("image", { recordId: record.id, width: 4032, height: 3024 });
    }
    return outcome.records.map((record) => record.id);
  }

  function backfillDeps() {
    return { aliases, database, fs: fs.fs };
  }

  /** Run batches back to back, the way the screen does. */
  async function runToCompletion(limit: number) {
    let after: string | null = null;
    let written = 0;
    let passes = 0;
    for (;;) {
      const outcome = await backfillImageExif(backfillDeps(), { limit, after });
      written += outcome.written;
      passes += 1;
      if (outcome.complete) return { written, passes };
      after = outcome.resumeAfter;
      if (passes > 50) throw new Error("backfill did not terminate");
    }
  }

  it("repairs the records a header was never read for", async () => {
    const ids = await importedWithoutExif(3);
    const outcome = await backfillImageExif(backfillDeps(), { limit: 24 });

    expect(outcome.written).toBe(3);
    expect(outcome.complete).toBe(true);
    for (const id of ids) {
      const metadata = await database.getMetadata("image", id);
      expect(metadata?.["orientation"]).toBe(6);
      expect(metadata?.["captured_at"]).toMatch(/^2026-0\d-01T12:00:00$/);
    }
  });

  it("leaves the dimensions the record already had", async () => {
    // `putMetadata` merges columns, and this pass writes only what it learned.
    // Clobbering width and height would be worse than writing nothing: variant
    // resolution orders renditions by long edge and drops a parent with none.
    const [id] = await importedWithoutExif(1);
    await backfillImageExif(backfillDeps(), { limit: 24 });

    const row = await database.getMetadata("image", id!);
    expect(row).toMatchObject({ width: 4032, height: 3024 });
  });

  it("walks the node's own aliases, not the device's camera roll", async () => {
    // The bug this replaced: the pass walked `modificationTime` forward through
    // the media store, which on the handset held 4,806 images against the 96
    // this node had imported — and the 96 were at the far end. It reached
    // November 2018 and wrote nothing. Nothing here consults a media store at
    // all, so a device holding a hundred thousand unimported photographs costs
    // this pass exactly the same as one holding none.
    const ids = await importedWithoutExif(2);
    const outcome = await backfillImageExif(backfillDeps(), { limit: 24 });

    expect(outcome.written).toBe(2);
    expect(outcome.scanned).toBe(ids.length);
  });

  it("leaves a record that already has both columns alone", async () => {
    const [id] = await importedWithoutExif(1);
    await database.putMetadata("image", {
      recordId: id!,
      captured_at: "1999-01-01T00:00:00",
      orientation: 1,
    });

    const outcome = await backfillImageExif(backfillDeps(), { limit: 24 });

    // Not read at all: an earlier answer is as good as this pass's, and
    // re-reading the file to confirm it is the cost this pass exists to bound.
    expect(outcome.written).toBe(0);
    expect(outcome.scanned).toBe(0);
    const row = await database.getMetadata("image", id!);
    expect(row?.["captured_at"]).toBe("1999-01-01T00:00:00");
  });

  it("resumes where the previous batch stopped, and reaches every record", async () => {
    const ids = await importedWithoutExif(7);
    const { written, passes } = await runToCompletion(2);

    expect(written).toBe(7);
    expect(passes).toBeGreaterThan(1);
    for (const id of ids) {
      expect((await database.getMetadata("image", id))?.["captured_at"]).toBeTruthy();
    }
  });

  it("writes nothing for a photograph whose header says nothing", async () => {
    const uri = "content://media/external/images/media/200";
    putAsset(uri, jpegWithExif({}));
    const outcome = await importDeviceMedia(deps([asset({ id: uri })]), { limit: 1 });
    await database.deleteMetadata("image", outcome.records[0]!.id);
    await database.putMetadata("image", { recordId: outcome.records[0]!.id, width: 1, height: 1 });

    const pass = await backfillImageExif(backfillDeps(), { limit: 24 });

    // A row holding only its key is one every reader has to treat as
    // present-but-empty, so none is written at all.
    expect(pass.written).toBe(0);
    expect(pass.scanned).toBe(1);
    const row = await database.getMetadata("image", outcome.records[0]!.id);
    expect(row?.["captured_at"]).toBeUndefined();
  });

  it("reports completion on an empty node", async () => {
    const outcome = await backfillImageExif(backfillDeps(), { limit: 24 });
    expect(outcome).toMatchObject({ scanned: 0, written: 0, complete: true, resumeAfter: null });
  });
});

describe("assets the watermark can never see", () => {
  const NULL_URI = "content://media/external/images/media/500";

  beforeEach(() => {
    putAsset(NULL_URI, jpegWithExif({ dateTimeOriginal: "2026:08:08 08:08:08" }));
  });

  it("imports an asset the media store recorded no modification time for", async () => {
    // The permanent blind spot: `importDeviceMedia` filters on
    // `modificationTime >= floor` and a NULL satisfies no comparison, so this
    // asset is skipped on every pass and would be skipped on every future one.
    const rows = [asset({ id: NULL_URI, modificationTime: null, creationTime: null })];
    const outcome = await importNullModified(deps(rows), { limit: 10 });

    expect(outcome.imported).toBe(1);
  });

  it("stops at the first asset that does have one", async () => {
    // Past the null bucket lies the oldest end of the camera roll, and
    // importing that is the foreground button's job. A sweep that kept going
    // would quietly become a backfill of the whole library.
    const older = "content://media/external/images/media/501";
    putAsset(older, PHOTO);
    const rows = [
      asset({ id: NULL_URI, modificationTime: null, creationTime: null }),
      asset({ id: older, modificationTime: 1 }),
    ];

    const outcome = await importNullModified(deps(rows), { limit: 10 });

    expect(outcome.imported).toBe(1);
    expect(aliases.byAssetId(older)).toBeNull();
  });

  it("does not import the same asset twice", async () => {
    const rows = [asset({ id: NULL_URI, modificationTime: null, creationTime: null })];
    await importNullModified(deps(rows), { limit: 10 });
    const second = await importNullModified(deps(rows), { limit: 10 });

    // A null mtime on both sides reads as "unverifiable", not as "changed" —
    // re-importing and re-hashing on every sweep forever would cost real work
    // to learn nothing. See `alreadyImported`.
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("asks the media store for the null bucket, which is the head of an ascending scan", async () => {
    const rows = [asset({ id: NULL_URI, modificationTime: null, creationTime: null })];
    await importNullModified(deps(rows), { limit: 10 });

    // Ascending and unfloored together are what put the null-keyed rows in
    // reach: SQLite sorts NULLs first ascending, and the media store is SQLite.
    // Either alone leaves them exactly as unreachable as the import walk does.
    expect(lastOrderBy).toEqual({ key: "modificationTime", ascending: true });
  });
});

describe("backfillThumbHashes", () => {
  /**
   * A node that imported some records before it could make a placeholder.
   *
   * The state every record on this device was in until now: `thumb_hash` is
   * written during derivation, and this device derives nothing — so a photograph
   * from its own camera roll had no placeholder until another node ran `sharp`
   * over it and synced the column back.
   */
  async function importedWithoutThumbHashes(count: number): Promise<StarkeepId[]> {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      const uri = `content://media/external/images/media/${200 + i}`;
      // Distinct bytes per asset, not the shared fixture. The alias table is
      // keyed by object storage key, which is the content hash — so three copies
      // of one photograph are one record and one alias, and a backfill over them
      // would have exactly one thing to repair.
      putAsset(uri, Uint8Array.from(PHOTO, (byte) => (byte + i) % 256));
      rows.push(asset({ id: uri, modificationTime: 1_700_000_000_000 + i * 1000 }));
    }
    // No `thumbHash` dep, which is exactly how the import ran before this
    // existed — the encoder is optional and its absence means "do not compute
    // one".
    const outcome = await importDeviceMedia(deps(rows), { limit: count });
    return outcome.records.map((record) => record.id);
  }

  /** An encoder that answers, and counts what it was asked about. */
  function encoder(options: { readonly fails?: Set<string> } = {}) {
    const seen: string[] = [];
    return {
      seen,
      encode: async (uri: string) => {
        seen.push(uri);
        // Null for a file the decoder could not read, which must cost nothing.
        return options.fails?.has(uri) ? null : `hash-for-${uri.split("/").pop()}`;
      },
    };
  }

  function backfillDeps(encode: (uri: string) => Promise<string | null>) {
    return { aliases, database, encode };
  }

  /** Run batches back to back, the way the screen does. */
  async function runToCompletion(limit: number, encode: (uri: string) => Promise<string | null>) {
    let after: string | null = null;
    let written = 0;
    let passes = 0;
    for (;;) {
      const outcome = await backfillThumbHashes(backfillDeps(encode), { limit, after });
      written += outcome.written;
      passes += 1;
      if (outcome.complete) return { written, passes };
      after = outcome.resumeAfter;
      if (passes > 50) throw new Error("backfill did not terminate");
    }
  }

  it("gives a placeholder to every record that had none", async () => {
    const ids = await importedWithoutThumbHashes(3);
    const { encode } = encoder();

    const outcome = await backfillThumbHashes(backfillDeps(encode), { limit: 24 });

    expect(outcome.written).toBe(3);
    expect(outcome.complete).toBe(true);
    for (const id of ids) {
      expect((await database.getMetadata("image", id))?.["thumb_hash"]).toMatch(/^hash-for-/);
    }
  });

  it("reports completion only at the end of the walk, and resumes where it stopped", async () => {
    await importedWithoutThumbHashes(5);
    const { encode } = encoder();

    const first = await backfillThumbHashes(backfillDeps(encode), { limit: 2 });
    expect(first.complete).toBe(false);
    expect(first.resumeAfter).not.toBeNull();

    // Resuming rather than restarting is the whole of the position: a walk that
    // began again from the top would re-decode the batch it just finished, on
    // every pass, forever.
    const { written, passes } = await runToCompletion(2, encode);
    expect(first.written + written).toBe(5);
    expect(passes).toBeGreaterThan(1);
  });

  it("skips a record that already has one, without decoding it", async () => {
    const ids = await importedWithoutThumbHashes(3);
    await database.putMetadata("image", { recordId: ids[0]!, thumb_hash: "already-here" });
    const { encode, seen } = encoder();

    const outcome = await backfillThumbHashes(backfillDeps(encode), { limit: 24 });

    // The point of reading the metadata before opening any file: the expensive
    // step runs only for records that need it.
    expect(outcome.written).toBe(2);
    expect(seen).toHaveLength(2);
    expect((await database.getMetadata("image", ids[0]!))?.["thumb_hash"]).toBe("already-here");
  });

  it("writes nothing for a file the decoder could not read, and does not fail", async () => {
    const ids = await importedWithoutThumbHashes(2);
    // Which URI belongs to which record is the alias table's answer, and the
    // walk is over that table — so the failing file is named the way the pass
    // will find it.
    const failing = aliases.listAfter(null, 10).find((alias) => alias.recordId === ids[0])!;
    const { encode } = encoder({ fails: new Set([failing.contentUri]) });

    const outcome = await backfillThumbHashes(backfillDeps(encode), { limit: 24 });

    // One repaired, one left alone, and the pass reports completion rather than
    // an error. A photograph with no placeholder is an ordinary state.
    expect(outcome.written).toBe(1);
    expect(outcome.scanned).toBe(2);
    expect(outcome.complete).toBe(true);
    expect((await database.getMetadata("image", ids[0]!))?.["thumb_hash"]).toBeUndefined();
  });

  it("survives a decoder that throws", async () => {
    await importedWithoutThumbHashes(2);

    const outcome = await backfillThumbHashes(
      backfillDeps(() => Promise.reject(new Error("no decoder here"))),
      { limit: 24 },
    );

    expect(outcome.written).toBe(0);
    expect(outcome.complete).toBe(true);
  });

  it("gives a clip a placeholder too, in the video table", async () => {
    // `expo-image` paints a clip's first frame, so the same encoder answers for
    // a video — and the `video` category declares `thumb_hash` for exactly this
    // reason. A grid that placed every still and left a hole where each clip
    // goes would look like a grid with missing data.
    const uri = "content://media/external/video/media/300";
    putAsset(uri, PHOTO);
    const outcome = await importDeviceMedia(
      deps([asset({ id: uri, filename: "clip.mp4", mediaType: "video" })]),
      { limit: 1 },
    );
    const id = outcome.records[0]!.id;
    const { encode } = encoder();

    const pass = await backfillThumbHashes(backfillDeps(encode), { limit: 24 });

    expect(pass.written).toBe(1);
    expect((await database.getMetadata("video", id))?.["thumb_hash"]).toMatch(/^hash-for-/);
  });

  it("leaves the import watermark exactly where it was", async () => {
    // The pass walks the node's own alias table and never the media store, so
    // there is nothing for it to move. Asserted rather than assumed, because a
    // repair that dragged the import watermark forward would make the ordinary
    // import skip whatever it had passed.
    const cursor = createSqliteImportCursorStore({ db: rawDb() });
    cursor.set(1_700_000_004_000);
    await importedWithoutThumbHashes(3);
    const { encode } = encoder();

    await runToCompletion(2, encode);

    expect(cursor.get()).toBe(1_700_000_004_000);
  });

  it("reports completion on a node that imported nothing", async () => {
    const { encode } = encoder();

    const outcome = await backfillThumbHashes(backfillDeps(encode), { limit: 24 });

    expect(outcome).toEqual({ scanned: 0, written: 0, complete: true, resumeAfter: null });
  });
});

describe("the ThumbHash written at import", () => {
  it("lands on the record's metadata row alongside everything else", async () => {
    // One `putMetadata`, not two: a second write for one column is a second
    // write of every column beside it.
    const outcome = await importDeviceMedia(
      { ...deps(), thumbHash: async () => "inline-hash" },
      { limit: 1 },
    );

    const row = await database.getMetadata("image", outcome.records[0]!.id);
    expect(row?.["thumb_hash"]).toBe("inline-hash");
    expect(row?.["width"]).toBeDefined();
  });

  it("imports the record anyway when the encoder throws", async () => {
    // A decode that fails must not cost a record. What is lost is 25 bytes, and
    // the backfill offers the same file again on a later app open.
    const outcome = await importDeviceMedia(
      {
        ...deps(),
        thumbHash: () => Promise.reject(new Error("no decoder here")),
      },
      { limit: 1 },
    );

    expect(outcome.imported).toBe(1);
    expect(
      (await database.getMetadata("image", outcome.records[0]!.id))?.["thumb_hash"],
    ).toBeUndefined();
  });

  it("writes none when no encoder is supplied", async () => {
    // The default for a node with no image decoder — a laptop's fixtures, or the
    // seeding pass.
    const outcome = await importDeviceMedia(deps(), { limit: 1 });

    expect(
      (await database.getMetadata("image", outcome.records[0]!.id))?.["thumb_hash"],
    ).toBeUndefined();
  });
});
