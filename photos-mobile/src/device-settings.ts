/**
 * This device's settings: the photo sync-down ceiling, and whether this device
 * derives photo stand-ins.
 *
 * Two owners share one row. The ceiling is the platform's — it decides which
 * bytes the node's sync engine brings down — and it surfaces here because a
 * phone has no admin-web. Photo derivation is Photos' own work. Both are this
 * device's alone and travel with nothing.
 *
 * Kept in the node's database rather than in a file, because the background
 * task opens that database and must read the derivation switch without the UI.
 * One row, for the reason `scan-cursor.ts` gives: a table that could hold other
 * things is a table somebody will put something else in.
 */

import type { RawDatabase } from "@starkeep/storage-adapter";
import { DEFAULT_STAND_IN_STANDARDS, DEFAULT_SYNC_DOWN_CEILINGS } from "@starkeep/protocol-primitives";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";

export interface DeviceSettings {
  /** The largest photo stand-in this device receives without being asked; null for none. */
  readonly imageCeiling: number | null;
  /**
   * Whether this device derives photo stand-ins and fills in each photo's
   * dimensions and placeholder in the background. The viewer's derive for the
   * photograph on screen runs either way.
   */
  readonly derivePhotoStandIns: boolean;
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  imageCeiling: DEFAULT_SYNC_DOWN_CEILINGS.phone.image,
  derivePhotoStandIns: true,
};

/**
 * The photo ceilings a person can choose: none, each standard size, and the
 * canonical size. Read off the standards so a respecification carries them.
 */
export const IMAGE_CEILING_CHOICES: readonly (number | null)[] = [
  null,
  ...DEFAULT_STAND_IN_STANDARDS.image.standardSizes,
  DEFAULT_STAND_IN_STANDARDS.image.canonicalThreshold,
];

/**
 * A stored row as settings, falling back field by field. A value this build
 * does not offer is dropped rather than trusted: an old row must not pin the
 * device to a ceiling nobody can choose any more.
 */
export function parseDeviceSettings(raw: string | null | undefined): DeviceSettings {
  if (!raw) return DEFAULT_DEVICE_SETTINGS;
  let parsed: Partial<Record<keyof DeviceSettings, unknown>>;
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return DEFAULT_DEVICE_SETTINGS;
  }
  const imageCeiling = IMAGE_CEILING_CHOICES.includes(parsed.imageCeiling as number | null)
    ? (parsed.imageCeiling as number | null)
    : DEFAULT_DEVICE_SETTINGS.imageCeiling;
  const derivePhotoStandIns =
    typeof parsed.derivePhotoStandIns === "boolean"
      ? parsed.derivePhotoStandIns
      : DEFAULT_DEVICE_SETTINGS.derivePhotoStandIns;
  return { imageCeiling, derivePhotoStandIns };
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
