/**
 * The EXIF backfill against the **real** `SqliteDatabaseAdapter`.
 *
 * This file exists because of a specific escape. The backfill's own tests run
 * against `MockDatabaseAdapter`, which stores only the metadata columns somebody
 * actually wrote — so a column nobody has filled reads as `undefined` there. A
 * real SQLite row has every column, and an unfilled one reads as `null`. The
 * pass guarded on `!== undefined`, which is true of `null`, so it skipped every
 * record it was meant to repair: on the handset, five batches over ninety-seven
 * aliases scanning nothing, while the whole suite stayed green.
 *
 * Anything asking "has this column been filled" therefore has to be exercised
 * against a real row, not a sparse one. That is the only thing this file does.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SqliteDatabaseAdapter } from "@starkeep/storage-sqlite";
import { createOpSqliteDriver, type OpSqliteConnection } from "../src/db/op-sqlite-driver";
import { createDataRecord, createHLCClock } from "@starkeep/protocol-primitives";
import { createSqliteMediaAliasStore, type MediaAliasStore } from "../src/media/media-alias";
import { backfillImageExif } from "../src/media/import";
import type { RawDatabase } from "@starkeep/storage-adapter";
import { fakeExpoFs } from "./helpers/fake-expo-fs";
import { jpegWithExif } from "./helpers/jpeg-exif";

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

const clock = createHLCClock({ nodeId: "phone" });
let adapter: SqliteDatabaseAdapter;
let aliases: MediaAliasStore;
let fs: ReturnType<typeof fakeExpoFs>;

beforeEach(async () => {
  adapter = new SqliteDatabaseAdapter({
    path: "local.sqlite",
    driver: createOpSqliteDriver(fakeOpSqlite()),
  });
  await adapter.init();
  aliases = createSqliteMediaAliasStore({ db: adapter.getRawDatabase() as RawDatabase });
  fs = fakeExpoFs();
});

afterEach(async () => {
  await adapter.close();
});

/** A still this node imported, with the metadata row `1ca50ea` would have left. */
async function importedStill(index: number, exif: Parameters<typeof jpegWithExif>[0]) {
  const uri = `content://media/external/images/media/${100 + index}`;
  const file = fs.fs.file(uri);
  file.create({ intermediates: true, overwrite: true });
  file.write(jpegWithExif(exif));

  const record = createDataRecord(
    {
      type: "image/jpeg",
      originAppId: "photos",
      contentHash: `sha256:${String(index).padStart(60, "0")}`,
      objectStorageKey: `shared/image/ab/${String(index).padStart(8, "0")}`,
      mimeType: "image/jpeg",
      sizeBytes: 1024,
      originalFilename: `photo-${index}.jpg`,
    },
    clock,
  );
  // Dimensions and nothing else, which is the row the phone wrote before it
  // read headers — and the row whose `captured_at` is SQL NULL rather than
  // absent.
  await adapter.putMetadata("image", { recordId: record.id, width: 4032, height: 3024 });
  await adapter.put(record);
  aliases.add({
    objectStorageKey: record.objectStorageKey!,
    recordId: record.id,
    contentUri: uri,
    assetId: uri,
    sizeBytes: 1024,
    contentType: "image/jpeg",
    modificationTimeMs: 1_700_000_000_000 + index,
    addedAtMs: 1_700_000_000_000 + index,
  });
  return record;
}

describe("backfillImageExif over real SQLite rows", () => {
  it("repairs a record whose capture time is NULL rather than absent", async () => {
    const record = await importedStill(1, {
      dateTimeOriginal: "2026:08:30 15:17:37",
      orientation: 6,
    });

    const outcome = await backfillImageExif(
      { aliases, database: adapter, fs: fs.fs },
      { limit: 24 },
    );

    // The assertion the mock could not make: a full row was read, its
    // `captured_at` was `null`, and the pass recognised that as work to do.
    expect(outcome.scanned).toBe(1);
    expect(outcome.written).toBe(1);
    const row = await adapter.getMetadata("image", record.id);
    expect(row).toMatchObject({
      captured_at: "2026-08-30T15:17:37",
      orientation: 6,
      width: 4032,
      height: 3024,
    });
  });

  it("skips a record whose columns are genuinely filled", async () => {
    const record = await importedStill(2, { dateTimeOriginal: "2026:01:01 00:00:00" });
    await adapter.putMetadata("image", {
      recordId: record.id,
      captured_at: "1999-01-01T00:00:00",
      orientation: 1,
    });

    const outcome = await backfillImageExif(
      { aliases, database: adapter, fs: fs.fs },
      { limit: 24 },
    );

    expect(outcome.scanned).toBe(0);
    expect((await adapter.getMetadata("image", record.id))?.["captured_at"]).toBe(
      "1999-01-01T00:00:00",
    );
  });

  it("does not read a video's alias", async () => {
    const uri = "content://media/external/video/media/9";
    const file = fs.fs.file(uri);
    file.create({ intermediates: true, overwrite: true });
    file.write(new Uint8Array(64));
    const record = createDataRecord(
      {
        type: "video/mp4",
        originAppId: "photos",
        contentHash: `sha256:${"9".repeat(64)}`,
        objectStorageKey: "shared/video/ab/99999999",
        mimeType: "video/mp4",
        sizeBytes: 1024,
        originalFilename: "clip.mp4",
      },
      clock,
    );
    await adapter.put(record);
    aliases.add({
      objectStorageKey: record.objectStorageKey!,
      recordId: record.id,
      contentUri: uri,
      assetId: uri,
      sizeBytes: 1024,
      contentType: "video/mp4",
      modificationTimeMs: 1,
      addedAtMs: 1,
    });

    const outcome = await backfillImageExif(
      { aliases, database: adapter, fs: fs.fs },
      { limit: 24 },
    );

    // An alias table holds videos too, and the record's own type is what says
    // so — a metadata lookup cannot, because a video and an unwritten still are
    // both simply absent from it.
    expect(outcome.scanned).toBe(0);
  });

  it("repairs a still that has no metadata row at all", async () => {
    // Imported before anything wrote dimensions, so there is no row to read a
    // NULL out of. The record's type is what makes it reachable.
    const record = await importedStill(3, { dateTimeOriginal: "2026:05:05 05:05:05" });
    await adapter.deleteMetadata("image", record.id);

    const outcome = await backfillImageExif(
      { aliases, database: adapter, fs: fs.fs },
      { limit: 24 },
    );

    expect(outcome.written).toBe(1);
    expect((await adapter.getMetadata("image", record.id))?.["captured_at"]).toBe(
      "2026-05-05T05:05:05",
    );
  });
});
