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
import { createHLCClock, dataRecordObjectKey } from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, type RawDatabase } from "@starkeep/storage-adapter";
import { createSqliteMediaAliasStore, type MediaAliasStore } from "../src/media/media-alias";
import {
  importDeviceMedia,
  IMPORTABLE_MEDIA_TYPES,
  noYield,
  MAX_INLINE_READ_BYTES,
  type HashBytes,
} from "../src/media/import";
import type {
  AssetMetadataLike,
  DeviceMediaModule,
  MediaQuery,
} from "../src/media/device-library";
import { fakeExpoFs } from "./helpers/fake-expo-fs";

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
});
