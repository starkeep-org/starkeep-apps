/**
 * The alias table, against a real SQLite engine.
 *
 * Real rather than a map, because the things worth asserting here are things
 * only SQL does: the primary-key upsert, which column the conflict clause is
 * allowed to move, and the aggregate. A fake keyed on a JS object would agree
 * with every one of these assertions and with a table that had no upsert at
 * all.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { StarkeepId } from "@starkeep/protocol-primitives";
import type { RawDatabase } from "@starkeep/storage-adapter";
import { createSqliteMediaAliasStore, type MediaAliasStore } from "../src/media/media-alias";

function rawDb(): RawDatabase {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        run: (...params: unknown[]) => stmt.run(...(params as never[])),
        get: (...params: unknown[]) => stmt.get(...(params as never[])),
        all: (...params: unknown[]) => stmt.all(...(params as never[])),
      };
    },
  };
}

const id = (s: string) => s as unknown as StarkeepId;

function alias(overrides: Partial<Parameters<MediaAliasStore["add"]>[0]> = {}) {
  return {
    objectStorageKey: "shared/image/ab/abcd",
    recordId: id("rec-1"),
    contentUri: "content://media/external/images/media/1",
    assetId: "1",
    sizeBytes: 3_000_000,
    contentType: "image/jpeg",
    modificationTimeMs: 1_700_000_000_000,
    addedAtMs: 1_700_000_100_000,
    ...overrides,
  };
}

let store: MediaAliasStore;

beforeEach(() => {
  store = createSqliteMediaAliasStore({ db: rawDb() });
});

describe("createSqliteMediaAliasStore", () => {
  it("round-trips an alias", () => {
    store.add(alias());
    expect(store.get("shared/image/ab/abcd")).toEqual(alias());
  });

  it("reports an unaliased key as absent rather than throwing", () => {
    expect(store.get("shared/image/zz/nope")).toBeNull();
    expect(store.isAliased("shared/image/zz/nope")).toBe(false);
  });

  it("finds an alias by asset id, which is how a scan asks", () => {
    store.add(alias());
    expect(store.byAssetId("1")?.objectStorageKey).toBe("shared/image/ab/abcd");
    expect(store.byAssetId("absent")).toBeNull();
  });

  it("re-resolves a moved asset to its new content URI", () => {
    // The media store genuinely does this — moving an asset between volumes
    // changes the URI while the bytes, and therefore the key, stay put.
    store.add(alias());
    store.add(alias({ contentUri: "content://media/external/images/media/999", assetId: "999" }));

    expect(store.get("shared/image/ab/abcd")?.contentUri).toBe(
      "content://media/external/images/media/999",
    );
    expect(store.byAssetId("999")).not.toBeNull();
    expect(store.byAssetId("1")).toBeNull();
  });

  it("moves record_id on re-import, so a crash-recovered record is not orphaned", () => {
    // The scenario the import loop's two-phase write exists for: the alias was
    // written, the process died before the record was, and recovery re-imports
    // the same bytes under a new record id. A row that refused to move would
    // point at a record that never existed, forever.
    store.add(alias({ recordId: id("rec-dead") }));
    store.add(alias({ recordId: id("rec-live") }));

    expect(store.get("shared/image/ab/abcd")?.recordId).toBe("rec-live");
  });

  it("does not duplicate a row when the same asset is imported twice", () => {
    store.add(alias());
    store.add(alias());
    expect(store.ofRecord(id("rec-1"))).toHaveLength(1);
  });

  it("removes an alias without disturbing others", () => {
    store.add(alias());
    store.add(alias({ objectStorageKey: "shared/image/cd/cdef", assetId: "2", recordId: id("rec-2") }));

    store.remove("shared/image/ab/abcd");

    expect(store.isAliased("shared/image/ab/abcd")).toBe(false);
    expect(store.isAliased("shared/image/cd/cdef")).toBe(true);
  });

  it("totals aliased bytes, and answers zero rather than null when empty", () => {
    // Zero-on-empty is the assertion that matters: `SUM` over no rows is NULL
    // in SQLite, and a residency inspector rendering "null bytes held" is the
    // kind of thing nobody notices until the screen is built.
    expect(store.totalBytes()).toBe(0);

    store.add(alias());
    store.add(alias({ objectStorageKey: "shared/image/cd/cdef", assetId: "2", sizeBytes: 1_000_000 }));

    expect(store.totalBytes()).toBe(4_000_000);
  });

  it("keeps a null modification time as null rather than coercing it", () => {
    // Null means "the media store recorded none", which the import loop must
    // read as unverifiable. Coercing it to 0 would make it compare equal to a
    // genuine epoch-zero mtime and silently skip a changed asset.
    store.add(alias({ modificationTimeMs: null }));
    expect(store.get("shared/image/ab/abcd")?.modificationTimeMs).toBeNull();
  });
});
