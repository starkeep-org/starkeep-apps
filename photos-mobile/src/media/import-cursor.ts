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

/**
 * How far back of now import reaches into the camera roll: fourteen days.
 *
 * Import adds the camera roll to this node; it does not decide what the node
 * syncs. A phone holding years of photographs would otherwise either add none
 * of them or hash all of them, and neither is what someone opening the app for
 * the first time expects.
 *
 * **A release may widen this, and every install follows.** Raise it to ninety
 * days, or to `Number.POSITIVE_INFINITY` for the whole camera roll, and the
 * next pass on each device walks back over the gap once. See
 * {@link reachImportCursor}. Narrowing it removes nothing: what import has
 * already added stays added.
 *
 * Measured on `DATE_MODIFIED`, the field the whole walk runs on, so the reach
 * holds what appeared on this device in that span. For a camera capture that
 * is when it was taken. A photograph saved or received recently counts as
 * recent even when its EXIF date is old.
 */
export const IMPORT_REACH_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Where the reach starts at a given moment: {@link IMPORT_REACH_MS} before
 * now, and never before the epoch, which is what an infinite reach becomes.
 */
export function importReachFloor(nowMs: number, reachMs: number = IMPORT_REACH_MS): number {
  return Math.max(0, nowMs - reachMs);
}

/**
 * How far back import has walked on this node: the oldest floor it has ever
 * started a walk from.
 *
 * Its own table rather than a second column, for the reason the file comment
 * gives. Not `media_import_reach`: that table belongs to a rewind removed on
 * 2026-10-21, holds a different column, and may still sit in a phone's
 * database.
 */
export const IMPORT_FLOOR_TABLE = "media_import_floor";

/**
 * Where the watermark has to be for import to cover this release's reach, or
 * null when it already does.
 *
 * `covered` is null on a node that predates the floor table. Such a node
 * started its walk wherever the watermark sat when it first looked, so that
 * watermark is how far back it has reached.
 *
 * **The one place a watermark moves backwards**, and only to a floor nothing
 * has walked from yet. A floor at or after `covered` changes nothing, which is
 * the steady state: a time-relative floor moves forward every day, so a reach
 * that never changes never rewinds again after a node's first look. The walk
 * from the new floor re-offers assets this node already holds, and
 * `alreadyImported` settles each in an alias lookup.
 */
export function reachImportCursor(
  cursor: number | null,
  covered: number | null,
  floor: number,
): number | null {
  const reached = covered ?? cursor;
  if (reached !== null && floor >= reached) return null;
  return cursor === null ? floor : Math.min(cursor, floor);
}

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
