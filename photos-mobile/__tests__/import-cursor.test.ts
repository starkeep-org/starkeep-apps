import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { RawDatabase } from "@starkeep/storage-adapter";
import {
  advanceImportCursor,
  createSqliteImportCursorStore,
  CURSOR_OVERLAP_MS,
  queryFloorFor,
  rewindImportCursorForReach,
  VIDEO_DURATION_CURSOR_TABLE,
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

describe("rewinding when import can read more", () => {
  let db: RawDatabase;
  // The oldest asset this node ever imported, and a cursor well past it.
  const WINDOW_START = 1_690_000_000_000;
  const CURSOR = 1_700_000_000_000;

  beforeEach(() => {
    db = rawDb();
  });

  it("rewinds a node that walked under an older reach to the start of its window", () => {
    // The 10-14 videos sit below the cursor, because the watermark moves past a
    // failure, but inside the window this node imported. Re-walking the window
    // offers them again.
    const cursor = createSqliteImportCursorStore({ db });
    cursor.set(CURSOR);

    expect(rewindImportCursorForReach({ db, reach: 2, windowStartMs: WINDOW_START })).toBe(
      WINDOW_START,
    );
    expect(cursor.get()).toBe(WINDOW_START);
  });

  // The defect this replaced: a rewind to zero re-offered the whole camera roll,
  // 3,710 files where this node had imported 282.
  it("never offers anything older than the oldest asset this node imported", () => {
    const cursor = createSqliteImportCursorStore({ db });
    cursor.set(CURSOR);

    rewindImportCursorForReach({ db, reach: 2, windowStartMs: WINDOW_START });

    // The walk asks for `>= floor`; the overlap is the media store's one-second
    // granularity, never a reach into older assets.
    expect(queryFloorFor(cursor.get())).toBe(WINDOW_START - CURSOR_OVERLAP_MS);
    expect(cursor.get()).not.toBe(0);
  });

  it("leaves the cursor alone when no imported asset carries a date", () => {
    const cursor = createSqliteImportCursorStore({ db });
    cursor.set(CURSOR);

    expect(rewindImportCursorForReach({ db, reach: 2, windowStartMs: null })).toBeNull();
    expect(cursor.get()).toBe(CURSOR);
  });

  it("never moves the cursor forward", () => {
    const cursor = createSqliteImportCursorStore({ db });
    cursor.set(WINDOW_START);

    expect(rewindImportCursorForReach({ db, reach: 2, windowStartMs: CURSOR })).toBeNull();
    expect(cursor.get()).toBe(WINDOW_START);
  });

  it("rewinds once per reach, not on every bring-up", () => {
    const cursor = createSqliteImportCursorStore({ db });
    cursor.set(CURSOR);
    rewindImportCursorForReach({ db, reach: 2, windowStartMs: WINDOW_START });
    cursor.set(CURSOR + 500_000);

    expect(rewindImportCursorForReach({ db, reach: 2, windowStartMs: WINDOW_START })).toBeNull();
    expect(cursor.get()).toBe(CURSOR + 500_000);
  });

  it("rewinds again when the reach goes up again", () => {
    const cursor = createSqliteImportCursorStore({ db });
    cursor.set(CURSOR);
    rewindImportCursorForReach({ db, reach: 2, windowStartMs: WINDOW_START });
    cursor.set(CURSOR + 500_000);

    expect(rewindImportCursorForReach({ db, reach: 3, windowStartMs: WINDOW_START })).toBe(
      WINDOW_START,
    );
    expect(cursor.get()).toBe(WINDOW_START);
  });

  it("leaves a fresh node's cursor null, so its first pass seeds as before", () => {
    const cursor = createSqliteImportCursorStore({ db });

    expect(rewindImportCursorForReach({ db, reach: 2, windowStartMs: null })).toBeNull();
    expect(cursor.get()).toBeNull();
    // And records the reach, so the node does not rewind later for assets it
    // could always read.
    cursor.set(CURSOR);
    expect(rewindImportCursorForReach({ db, reach: 2, windowStartMs: WINDOW_START })).toBeNull();
    expect(cursor.get()).toBe(CURSOR);
  });

  it("works before the cursor store has created its table", () => {
    expect(rewindImportCursorForReach({ db, reach: 2, windowStartMs: null })).toBeNull();
    expect(createSqliteImportCursorStore({ db }).get()).toBeNull();
  });

  it("does not touch the duration backfill's cursor", () => {
    const main = createSqliteImportCursorStore({ db });
    const durations = createSqliteImportCursorStore({ db, table: VIDEO_DURATION_CURSOR_TABLE });
    main.set(CURSOR);
    durations.set(1_600_000_000_000);

    rewindImportCursorForReach({ db, reach: 2, windowStartMs: WINDOW_START });

    expect(durations.get()).toBe(1_600_000_000_000);
  });
});

