import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { RawDatabase } from "@starkeep/storage-adapter";
import {
  advanceImportCursor,
  createSqliteImportCursorStore,
  CURSOR_OVERLAP_MS,
  importReachFloor,
  reachImportCursor,
  queryFloorFor,
} from "../src/media/import-cursor";

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

describe("where the next query starts", () => {
  it("has no floor before the first look", () => {
    // Null is "this node has never looked", and a node that has never looked
    // must not filter anything out.
    expect(queryFloorFor(null)).toBeNull();
  });

  it("starts one second behind the watermark", () => {
    // `MediaStore.DATE_MODIFIED` has one-second granularity, so a burst written
    // inside one second carries one value for every asset in it. A strict floor
    // at the watermark would drop every asset sharing that second with the last
    // one imported — permanently, since every later pass asks the same question.
    expect(queryFloorFor(1_700_000_000_000)).toBe(1_700_000_000_000 - CURSOR_OVERLAP_MS);
  });
});

describe("advancing the watermark", () => {
  it("takes the first reading when there is none", () => {
    expect(advanceImportCursor(null, 500)).toBe(500);
  });

  it("moves forward", () => {
    expect(advanceImportCursor(500, 900)).toBe(900);
  });

  it("never moves backward", () => {
    // The overlap window deliberately re-offers assets *below* the watermark.
    // Letting one of them pull the watermark down would re-offer everything
    // above it on the next window, which is the cost the watermark removes.
    expect(advanceImportCursor(900, 500)).toBe(900);
  });
});

describe("the stored watermark", () => {
  let store: ReturnType<typeof createSqliteImportCursorStore>;

  beforeEach(() => {
    store = createSqliteImportCursorStore({ db: rawDb() });
  });

  it("reads as null before anything is written", () => {
    expect(store.get()).toBeNull();
  });

  it("round-trips a reading", () => {
    store.set(1_700_000_000_000);

    expect(store.get()).toBe(1_700_000_000_000);
  });

  it("holds one watermark rather than a history", () => {
    // A fixed primary key, so the table is structurally incapable of holding a
    // second watermark that could disagree with the first.
    store.set(100);
    store.set(200);

    expect(store.get()).toBe(200);
  });

  it("survives a second store opened over the same database", () => {
    // The point of persisting it. The process that writes a watermark is the
    // one Android freezes and kills, and the next window is a different process.
    const db = rawDb();
    createSqliteImportCursorStore({ db }).set(1_234);

    expect(createSqliteImportCursorStore({ db }).get()).toBe(1_234);
  });
});

describe("the reach a release sets", () => {
  const NOW = 1_700_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  it("starts the reach the release's span before now", () => {
    expect(importReachFloor(NOW, 30 * DAY)).toBe(NOW - 30 * DAY);
  });

  it("turns an infinite reach into the whole roll", () => {
    expect(importReachFloor(NOW, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("seeds a node that has never looked at the floor", () => {
    expect(reachImportCursor(null, null, NOW - 30 * DAY)).toBe(NOW - 30 * DAY);
  });

  it("leaves a node alone once its walk covers the floor", () => {
    expect(reachImportCursor(NOW, NOW - 30 * DAY, NOW - 29 * DAY)).toBeNull();
  });

  it("steps back to a floor older than anything walked", () => {
    expect(reachImportCursor(NOW, NOW - 30 * DAY, NOW - 90 * DAY)).toBe(NOW - 90 * DAY);
  });

  it("never moves a watermark that is already behind the floor forward", () => {
    // Mid-backlog: the walk has not yet caught up to the floor it started from.
    expect(reachImportCursor(NOW - 100 * DAY, NOW - 30 * DAY, NOW - 90 * DAY)).toBe(NOW - 100 * DAY);
  });

  it("treats a node with no floor as having reached its watermark", () => {
    expect(reachImportCursor(NOW, null, NOW - 30 * DAY)).toBe(NOW - 30 * DAY);
    expect(reachImportCursor(NOW - 40 * DAY, null, NOW - 30 * DAY)).toBeNull();
  });
});
