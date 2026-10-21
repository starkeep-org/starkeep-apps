/**
 * How far import has walked the media store.
 *
 * ## Why a watermark and not a limit
 *
 * Import used to ask the media store for the newest twenty assets every window
 * and decide, one by one, which of them it had already seen. Deciding is cheap.
 * *Asking* is not: `Query.exeForMetadata()` runs `ExifInterface` and
 * `MediaMetadataRetriever` per returned row inside the media store process, and
 * the cost falls on every row whether or not the row is new.
 *
 * On a Pixel 5 that query was measured at **over nine and a half minutes for
 * twenty rows** against a camera roll holding one new photograph — long enough
 * that Android stopped the job, froze the process mid-call, and left the tick
 * suspended forever. The work the query paid for was the nineteen assets import
 * had already imported on a previous window.
 *
 * A watermark removes the rows rather than the decision. Filtering the query on
 * `modificationTime` means a quiet phone gets an empty result set and pays
 * nothing, and a phone with one new capture pays for one asset.
 *
 * ## Why milliseconds and why nullable
 *
 * The value is a `MediaStore.DATE_MODIFIED` reading in milliseconds, which is
 * the same field {@link listRecentMedia} orders on and the same field the alias
 * staleness check compares. One field, asked three ways, so no two of them can
 * drift.
 *
 * `null` is the whole vocabulary besides a position, and it means "this node has
 * never looked". It is the initial state and it is what a reset returns to.
 *
 * ## Why one row rather than a general key-value table
 *
 * Because there is one watermark per table, and a table that could hold others
 * is a table somebody will put something else in. `work/scan-cursor.ts` makes
 * the same argument for the acquisition sweep's cursor and this file
 * deliberately mirrors it — two cursors with two shapes would be two things to
 * reason about.
 *
 * ## Why the table is a parameter
 *
 * Because a second pass walks the media store the same way for a different
 * reason: {@link backfillVideoDurations} fills in the length of clips imported
 * before the record carried one. Same field, same monotonic rule, same
 * one-second overlap — and its own table, so neither watermark can be moved by
 * the other's progress. The shape is shared; the row never is.
 */

import type { RawDatabase } from "@starkeep/storage-adapter";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";

export interface ImportCursorStore {
  /** The newest `modificationTime` import has considered, or null if never run. */
  get(): number | null;
  /** Remember a position. Never moves backwards — see {@link advanceImportCursor}. */
  set(modificationTimeMs: number): void;
}

type DB = Record<string, Record<string, unknown>>;
const qb = new Kysely<DB>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

/** Where the import loop stopped walking the media store. */
export const IMPORT_CURSOR_TABLE = "media_import_cursor";

/**
 * Where the duration backfill stopped walking it.
 *
 * A separate row in a separate table, because the two passes walk the same
 * field in opposite directions for different reasons: import walks forward from
 * "now" to notice what is new, and the backfill walks forward from the
 * beginning of the roll to repair what is old. One watermark serving both would
 * make each pass skip whatever the other had reached.
 */
export const VIDEO_DURATION_CURSOR_TABLE = "video_duration_backfill_cursor";


/**
 * How far back of the watermark the next query starts.
 *
 * **One second, and the number is the media store's own granularity rather than
 * a margin of safety.** `MediaStore.DATE_MODIFIED` is stored in whole seconds,
 * so a burst of captures written inside the same second all carry the identical
 * value. A strict `>` filter against the watermark would drop every asset
 * sharing that second with the last one imported, permanently and silently —
 * the same shape of defect as ordering on a nullable column, which cost this app
 * a whole class of image once already.
 *
 * So the filter is `>=` against the watermark minus one second, and the assets
 * that overlap are re-offered rather than re-imported: `alreadyImported` settles
 * each in an alias lookup and a record read. The cost is a handful of rows on a
 * boundary, which is the price of never losing one.
 */
export const CURSOR_OVERLAP_MS = 1_000;

/** Where the next query should start, given a watermark. */
export function queryFloorFor(cursor: number | null): number | null {
  return cursor === null ? null : cursor - CURSOR_OVERLAP_MS;
}

/**
 * Move a watermark forward, never backward.
 *
 * Monotonic because the alternative is a watermark that walks backwards over a
 * clock the media store controls and this app does not. An asset whose
 * `DATE_MODIFIED` predates the watermark is behind it for a reason — it was
 * already considered — and letting it pull the watermark down would re-offer
 * everything above it on the next window, which is the cost this file exists to
 * remove.
 */
export function advanceImportCursor(current: number | null, seen: number): number {
  return current === null ? seen : Math.max(current, seen);
}

export function createSqliteImportCursorStore(options: {
  readonly db: RawDatabase;
  /** Defaults to {@link IMPORT_CURSOR_TABLE}. */
  readonly table?: string;
}): ImportCursorStore {
  const { db } = options;
  const TABLE = options.table ?? IMPORT_CURSOR_TABLE;

  db.exec(
    qb.schema
      .createTable(TABLE)
      .ifNotExists()
      // A fixed primary key, so the table is structurally incapable of holding
      // a second watermark that could disagree with the first.
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("modification_time_ms", "integer")
      .compile().sql,
  );

  const getStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .select("modification_time_ms")
      .where("id", "=", sql.lit(0))
      .compile().sql,
  );
  const setStmt = db.prepare(
    qb
      .insertInto(TABLE)
      .values({ id: sql.lit(0), modification_time_ms: sql.raw("?") })
      .onConflict((oc) =>
        oc
          .column("id")
          .doUpdateSet((eb) => ({ modification_time_ms: eb.ref("excluded.modification_time_ms") })),
      )
      .compile().sql,
  );

  return {
    get(): number | null {
      const row = getStmt.get() as { modification_time_ms: number | null } | undefined;
      return row?.modification_time_ms ?? null;
    },
    set(modificationTimeMs: number): void {
      setStmt.run(modificationTimeMs);
    },
  };
}

/** Which reach the import cursor was last walked under. See {@link rewindImportCursorForReach}. */
export const IMPORT_REACH_TABLE = "media_import_reach";

/**
 * Which assets the import loop can read, as a number that only goes up.
 *
 * Bump it whenever import learns to accept an asset it used to fail on every
 * time. The watermark moves past a failure (see `importDeviceMedia`), so an
 * asset that failed under the old reach sits below the cursor and no pass will
 * offer it again. A bump makes the next bring-up walk this node's part of the
 * roll once more, from the oldest asset it ever imported.
 *
 * 1. Everything up to `MAX_INLINE_READ_BYTES`.
 * 2. Video of any size, hashed by the native streaming digest.
 */
export const IMPORT_REACH_STREAMED_VIDEO = 2;

/**
 * Walk this node's part of the camera roll again if import can now read more
 * than it could when the cursor last moved.
 *
 * ## Why the window's start and not the roll's
 *
 * Import walks forward from a watermark seeded at the newest asset on the
 * node's first look. So the part of the camera roll in Starkeep begins at the
 * oldest asset ever imported, and everything older was never offered. A failed
 * asset sits *inside* that window, behind the cursor. Rewinding to the window's
 * start re-offers exactly the window: imported assets are settled by
 * `alreadyImported` without a byte read, and the ones a lower reach refused
 * import now. Rewinding to zero instead would import the whole camera roll,
 * which no reach increase ever meant to do.
 *
 * `windowStartMs` is the oldest alias mtime (`MediaAliasStore.oldestModificationTimeMs`).
 * An asset that failed below it, older than anything this node imported, stays
 * out; the person adds it by hand like any other old asset.
 *
 * ## Why the write bypasses `set`'s contract
 *
 * {@link ImportCursorStore.set} promises never to move backwards, and every
 * caller relies on that through {@link advanceImportCursor}. This is the one
 * deliberate backwards move, so it writes the table itself rather than teaching
 * the store an exception.
 *
 * ## What a fresh node does
 *
 * Records the reach and leaves the cursor null. A node that has never looked
 * has failed on nothing, and its first pass seeds as it always has. A node with
 * a cursor but no dated alias has nothing to re-offer, and is left alone too.
 *
 * Answers the position it rewound to, or null when it did not move the cursor,
 * so bring-up can say so.
 */
export function rewindImportCursorForReach(options: {
  readonly db: RawDatabase;
  readonly reach: number;
  /** Where this node's imported window begins; see above. */
  readonly windowStartMs: number | null;
  /** Defaults to {@link IMPORT_CURSOR_TABLE}. */
  readonly cursorTable?: string;
}): number | null {
  const { db, reach, windowStartMs } = options;
  const cursorTable = options.cursorTable ?? IMPORT_CURSOR_TABLE;
  // The cursor store creates its own table, and this may run before it does.
  createSqliteImportCursorStore({ db, table: cursorTable });

  db.exec(
    qb.schema
      .createTable(IMPORT_REACH_TABLE)
      .ifNotExists()
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("reach", "integer", (c) => c.notNull())
      .compile().sql,
  );

  const stored = db
    .prepare(
      qb.selectFrom(IMPORT_REACH_TABLE).select("reach").where("id", "=", sql.lit(0)).compile().sql,
    )
    .get() as { reach: number } | undefined;
  if (stored && stored.reach >= reach) return null;

  const cursor = db
    .prepare(
      qb
        .selectFrom(cursorTable)
        .select("modification_time_ms")
        .where("id", "=", sql.lit(0))
        .compile().sql,
    )
    .get() as { modification_time_ms: number | null } | undefined;
  const current = cursor?.modification_time_ms ?? null;
  const rewindTo =
    current !== null && windowStartMs !== null && windowStartMs < current ? windowStartMs : null;

  if (rewindTo !== null) {
    db.prepare(
      qb
        .updateTable(cursorTable)
        .set({ modification_time_ms: sql.raw("?") })
        .where("id", "=", sql.lit(0))
        .compile().sql,
    ).run(rewindTo);
  }
  db.prepare(
    qb
      .insertInto(IMPORT_REACH_TABLE)
      .values({ id: sql.lit(0), reach: sql.raw("?") })
      .onConflict((oc) => oc.column("id").doUpdateSet((eb) => ({ reach: eb.ref("excluded.reach") })))
      .compile().sql,
  ).run(reach);
  return rewindTo;
}
