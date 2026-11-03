/**
 * Whether this library may import from the camera roll yet.
 *
 * ## Why a fresh library waits
 *
 * A fresh library — after "Clear storage", a reinstall, or on a new phone —
 * holds none of the records the person's other devices made. Importing then
 * cannot tell which camera-roll files are already records, or which of them
 * the person deleted in Starkeep: the rows that say so have not arrived. Every
 * record id is content-addressed, so a re-imported file mints the id of a row
 * the cloud already holds, and the phone's fresh copy wins everywhere under
 * its newer clock. A reset on 2026-10-28 rewrote 94 rows that way, and a photo
 * deleted in Starkeep but kept in the camera roll would have come back
 * (`findings-phone-reinstall-dedup-2026-10-28.md`).
 *
 * So a fresh library waits for one of two things:
 *
 * - **A sign-in and the first pull's rows.** Once a round reports that the
 *   cloud has no more rows to send, the library holds every row the cloud has,
 *   tombstones included, and `importOne` keeps any record that already exists.
 *   The gate needs only the rows. Each round applies its rows before it
 *   downloads files, and files follow against their own bytes watermark, so
 *   the gate does not wait for stand-ins to download. A file that will not
 *   download cannot hold it either.
 * - **The person's choice to import without the pull.** The app is
 *   local-first, so a phone that never syncs must still import, and the
 *   first-run screen offers "Import without signing in". A signed-in phone
 *   that cannot reach the cloud would otherwise wait forever, so the waiting
 *   screen offers the same choice. Each dialog says what the choice
 *   risks for someone who has used Starkeep elsewhere.
 *
 * A library that has imported before is never held: it already holds its
 * records, and holding it would only stop new photographs arriving.
 *
 * ## Gating import gates derivation
 *
 * The derivation sweep works only on records whose bytes this device holds
 * through an alias, and only the import creates aliases. Holding the import
 * therefore holds every stand-in this phone could derive over another node's.
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

/**
 * - `open`: import may run.
 * - `sign-in`: a fresh library with no session. The screen offers sign-in, and
 *   the escape hatch.
 * - `first-pull`: signed in, and waiting for the first pull's rows.
 */
export type ImportGate = "open" | "sign-in" | "first-pull";

export interface ImportGateFacts {
  /** The library holds at least one alias: this device has imported before. */
  readonly imported: boolean;
  /** The node has a cloud to sync with. */
  readonly hasCloud: boolean;
  /** A Drive-channel round on this library has drained the cloud's rows. */
  readonly drivePulled: boolean;
  /** The person chose to import without waiting for the first pull. */
  readonly importWithoutPull: boolean;
}

export function importGateOf(facts: ImportGateFacts): ImportGate {
  if (facts.imported || facts.drivePulled || facts.importWithoutPull) return "open";
  return facts.hasCloud ? "first-pull" : "sign-in";
}

/** The two facts the library stores for the gate. */
export interface ImportGateStore {
  drivePulled(): boolean;
  /** Record that a Drive-channel round drained the cloud's rows. */
  markDrivePulled(): void;
  importWithoutPull(): boolean;
  /** Record the person's choice to import without waiting for the first pull. */
  chooseImportWithoutPull(): void;
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

const DRIVE_PULLED_KEY = "import-gate:drive-pulled";
const WITHOUT_PULL_KEY = "import-gate:without-pull";

/**
 * The gate's facts, in the library's `sync_state` table, so a reset clears
 * them with the library and shows the first-run screen again. The Drive
 * channel's sync state store creates the table, and the node creates that
 * store first.
 */
export function createImportGateStore(db: RawDatabase): ImportGateStore {
  // sql.raw("?") leaves positional placeholders in the compiled SQL so the
  // statements can be prepared once here and bound per call below.
  const getStmt = db.prepare(
    qb.selectFrom("sync_state").select("value_json").where("key", "=", sql.raw("?")).compile().sql,
  );
  const setStmt = db.prepare(
    qb
      .insertInto("sync_state")
      .values({
        key: sql.raw("?"),
        value_json: sql.raw("?"),
        updated_at: sql`strftime('%s','now')`,
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet((eb) => ({
          value_json: eb.ref("excluded.value_json"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      )
      .compile().sql,
  );

  const isSet = (key: string): boolean => {
    const row = getStmt.get(key) as { value_json: string } | undefined;
    return row !== undefined && JSON.parse(row.value_json) === true;
  };
  const set = (key: string): void => {
    setStmt.run(key, JSON.stringify(true));
  };

  return {
    drivePulled: () => isSet(DRIVE_PULLED_KEY),
    markDrivePulled: () => set(DRIVE_PULLED_KEY),
    importWithoutPull: () => isSet(WITHOUT_PULL_KEY),
    chooseImportWithoutPull: () => set(WITHOUT_PULL_KEY),
  };
}
