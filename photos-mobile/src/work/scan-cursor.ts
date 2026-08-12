/**
 * Where the catalogue scan stopped last time.
 *
 * ## Why this is persisted rather than held in memory
 *
 * The scan walks the whole catalogue looking for records this device wants
 * bytes for and has none of. On a 60k-item library that is a few hundred pages,
 * and the phone's first constraint is that no work item may assume more than a
 * few seconds — so the walk *has* to span many short windows. A cursor that
 * lived in the process would be lost every time the OS reclaimed the app, and
 * the sweep would restart from the beginning on every boot and never once reach
 * the end. Not wrong, exactly: the scan is idempotent, and a restarted sweep
 * finds the same things. It would simply never finish.
 *
 * ## Why one row rather than a general key-value table
 *
 * Because there is one cursor, and a table that could hold others is a table
 * somebody will put something else in. `null` is the whole vocabulary besides a
 * position: it means "start from the beginning", which is both the initial
 * state and what a completed sweep resets to.
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

export interface ScanCursorStore {
  /** Where to resume, or null to start from the beginning of the catalogue. */
  get(): string | null;
  /** Remember a position, or `null` once the sweep has reached the end. */
  set(cursor: string | null): void;
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

const TABLE = "acquisition_scan_cursor";

export function createSqliteScanCursorStore(options: {
  readonly db: RawDatabase;
}): ScanCursorStore {
  const { db } = options;

  db.exec(
    qb.schema
      .createTable(TABLE)
      .ifNotExists()
      // A fixed primary key, so the table is structurally incapable of holding
      // a second cursor that could disagree with the first.
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("cursor", "text")
      .compile().sql,
  );

  const getStmt = db.prepare(
    qb.selectFrom(TABLE).select("cursor").where("id", "=", sql.lit(0)).compile().sql,
  );
  const setStmt = db.prepare(
    qb
      .insertInto(TABLE)
      .values({ id: sql.lit(0), cursor: sql.raw("?") })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet((eb) => ({ cursor: eb.ref("excluded.cursor") })),
      )
      .compile().sql,
  );

  return {
    get(): string | null {
      const row = getStmt.get() as { cursor: string | null } | undefined;
      return row?.cursor ?? null;
    },
    set(cursor: string | null): void {
      setStmt.run(cursor);
    },
  };
}
