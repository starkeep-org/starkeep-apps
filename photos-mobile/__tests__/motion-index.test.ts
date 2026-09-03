/**
 * Where the video is inside a Motion Photo, remembered.
 *
 * The table's whole job is to make two questions cheap that would otherwise
 * each cost a whole-file read: *is there motion in these bytes*, and *where*.
 * So the assertions are about what the store can answer without being handed
 * the bytes again — including the answer "there is nothing here", which is the
 * one that keeps the viewer's fallback from being paid on every opening.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { RawDatabase } from "@starkeep/storage-adapter";
import {
  createSqliteMotionIndexStore,
  type MotionIndexStore,
} from "../src/media/motion-index";

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

const KEY = "shared/image/ab/abcdef";

let store: MotionIndexStore;
beforeEach(() => {
  store = createSqliteMotionIndexStore({ db: rawDb() });
});

describe("what a row remembers", () => {
  it("round-trips a located clip", () => {
    store.record(KEY, {
      offset: 4_096,
      length: 1_234,
      mimeType: "video/mp4",
      via: "container-directory",
      presentationTimestampUs: 1_500_000,
    });

    expect(store.get(KEY)).toEqual({
      offset: 4_096,
      length: 1_234,
      mimeType: "video/mp4",
      via: "container-directory",
      presentationTimestampUs: 1_500_000,
    });
  });

  it("keeps the absent presentation timestamp absent rather than zero", () => {
    // Zero is a real position inside a clip — the first frame — so a missing
    // timestamp written as one would make a viewer start on the wrong frame and
    // look like it had chosen to.
    store.record(KEY, {
      offset: 10,
      length: 20,
      mimeType: "video/mp4",
      via: "micro-video-offset",
    });

    expect(store.get(KEY)).not.toHaveProperty("presentationTimestampUs");
  });
});

describe("telling 'no motion' apart from 'never looked'", () => {
  it("reports a key nothing has looked at as unscanned", () => {
    expect(store.scanned(KEY)).toBe(false);
    expect(store.get(KEY)).toBeNull();
  });

  it("remembers a scan that found nothing, so it is not paid for twice", () => {
    store.record(KEY, null);

    expect(store.scanned(KEY)).toBe(true);
    expect(store.get(KEY)).toBeNull();
  });

  it("lets a later scan correct an earlier one", () => {
    store.record(KEY, null);
    store.record(KEY, { offset: 8, length: 16, mimeType: "video/mp4", via: "micro-video-offset" });

    expect(store.get(KEY)).toMatchObject({ offset: 8 });
  });
});

describe("one row per photograph, not per record", () => {
  it("keeps one row when the same bytes are re-imported under a new record id", () => {
    // The crash window the import loop is built around: an import killed between
    // the alias write and the record write re-imports the same bytes under a new
    // record id. The key is the content hash, so the row is the same row.
    store.record(KEY, { offset: 8, length: 16, mimeType: "video/mp4", via: "micro-video-offset" });
    store.record(KEY, { offset: 8, length: 16, mimeType: "video/mp4", via: "micro-video-offset" });

    expect(store.get(KEY)).toMatchObject({ offset: 8, length: 16 });
  });
});

describe("the marker that makes an absent row an answer", () => {
  it("starts unset, so nothing is assumed to have been scanned", () => {
    expect(store.scannedFrom()).toBeNull();
  });

  it("never moves once set", () => {
    // It names when this node *started* looking. Advancing it would silently
    // reclassify every record imported in between as covered by a scan that
    // never happened.
    store.markScannedFrom(1_700_000_000_000);
    store.markScannedFrom(1_800_000_000_000);

    expect(store.scannedFrom()).toBe(1_700_000_000_000);
  });
});

describe("withMotion, the grid's question", () => {
  const clip = { offset: 4_096, length: 1_234, mimeType: "video/mp4", via: "container-directory" } as const;

  it("returns only the keys with a clip", () => {
    store.record("a", clip);
    store.record("b", clip);

    expect([...store.withMotion(["a", "b"])].sort()).toEqual(["a", "b"]);
  });

  it("excludes a key scanned and found still", () => {
    // The negative row exists to stop the fallback scan being paid twice. It
    // must not become a badge: "looked, found nothing" is not motion.
    store.record("still", null);

    expect([...store.withMotion(["still"])]).toEqual([]);
  });

  it("excludes a key nobody has scanned", () => {
    expect([...store.withMotion(["never-seen"])]).toEqual([]);
  });

  it("answers a mixed page in one call", () => {
    store.record("has", clip);
    store.record("scanned-still", null);

    const found = store.withMotion(["has", "scanned-still", "unscanned"]);

    expect([...found]).toEqual(["has"]);
  });

  it("asks nothing of the database for an empty page", () => {
    // A page of sixty videos yields no keys, and an `IN ()` is not valid SQL.
    expect([...store.withMotion([])]).toEqual([]);
  });
});
