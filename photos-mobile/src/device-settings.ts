/**
 * This device's settings: the sync-down ceilings, per stand-in category.
 *
 * The ceilings are the platform's. They decide which bytes the node's sync
 * engine brings down, and they surface here because a phone has no admin-web.
 * They take the shape the desktop keeps in `config.json` as `standInCeilings`,
 * read and checked by the same helpers, so a ceiling means one thing on every
 * node. The values are this device's alone and travel with nothing.
 *
 * Kept in the node's database rather than in a file, because the background
 * task opens that database and builds the residency manager without the UI.
 * One row, for the reason `scan-cursor.ts` gives: a table that could hold other
 * things is a table somebody will put something else in.
 */

import type { RawDatabase } from "@starkeep/storage-adapter";
import {
  DEFAULT_SYNC_DOWN_CEILINGS,
  resolveSyncDownCeilings,
  type ConfiguredCeilings,
  type SyncDownCeilings,
} from "@starkeep/protocol-primitives";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";

export interface DeviceSettings {
  /**
   * The largest fidelity this device receives without being asked, per
   * category; null for none. A category the person never set reads the phone
   * default, so the stored row holds only what the person changed.
   */
  readonly standInCeilings: ConfiguredCeilings;
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = { standInCeilings: {} };

/** The ceilings in force: the phone defaults with the person's values on top. */
export function ceilingsOf(settings: DeviceSettings): SyncDownCeilings {
  return resolveSyncDownCeilings(settings.standInCeilings, DEFAULT_SYNC_DOWN_CEILINGS.phone);
}

/**
 * A stored row as settings. A malformed ceiling is dropped rather than
 * trusted, so the category falls back to the phone default.
 */
export function parseDeviceSettings(raw: string | null | undefined): DeviceSettings {
  if (!raw) return DEFAULT_DEVICE_SETTINGS;
  let parsed: { standInCeilings?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return DEFAULT_DEVICE_SETTINGS;
  }
  const stored = parsed.standInCeilings;
  if (stored === null || typeof stored !== "object") return DEFAULT_DEVICE_SETTINGS;
  // Resolved against an empty default so only the valid values survive, and a
  // category nobody set stays absent rather than freezing today's default.
  const valid = resolveSyncDownCeilings(stored, { image: null, video: null });
  const standInCeilings: Record<string, number | null> = {};
  for (const [category, value] of Object.entries(valid)) {
    if ((stored as Record<string, unknown>)[category] === value) standInCeilings[category] = value;
  }
  return { standInCeilings };
}

export interface DeviceSettingsStore {
  get(): DeviceSettings;
  /** Merge a change into the stored settings and return the result. */
  update(change: Partial<DeviceSettings>): DeviceSettings;
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

const TABLE = "device_settings";

export function createDeviceSettingsStore(options: { readonly db: RawDatabase }): DeviceSettingsStore {
  const { db } = options;
  db.exec(
    qb.schema
      .createTable(TABLE)
      .ifNotExists()
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("settings", "text", (c) => c.notNull())
      .compile().sql,
  );
  const getStmt = db.prepare(
    qb.selectFrom(TABLE).select("settings").where("id", "=", sql.lit(0)).compile().sql,
  );
  const setStmt = db.prepare(
    qb
      .insertInto(TABLE)
      .values({ id: sql.lit(0), settings: sql.raw("?") })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet((eb) => ({ settings: eb.ref("excluded.settings") })),
      )
      .compile().sql,
  );

  const get = (): DeviceSettings => {
    const row = getStmt.get() as { settings: string } | undefined;
    return parseDeviceSettings(row?.settings);
  };

  return {
    get,
    update(change) {
      const next = parseDeviceSettings(JSON.stringify({ ...get(), ...change }));
      setStmt.run(JSON.stringify(next));
      return next;
    },
  };
}
