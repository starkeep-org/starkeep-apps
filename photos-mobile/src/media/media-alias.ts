/**
 * The alias table: which of this node's object-storage keys are held by the
 * device's own media store rather than by the node's object store.
 *
 * ## Why this exists instead of a symlink
 *
 * `ObjectStorageAdapter.putSymlink?()` already expresses "the bytes for this
 * key live somewhere else on this machine", and `storage-fs` implements it with
 * a real `symlink()` — which is how the local data server indexes a watched
 * folder without duplicating it.
 *
 * A phone cannot do that. MediaStore hands out `content://` URIs, not paths;
 * under scoped storage there *is* no filesystem path for the asset, and
 * `expo-file-system` exposes no symlink call. So the indirection moves up one
 * layer: instead of the filesystem resolving the pointer, the object-storage
 * adapter does, through this table. Same idea, one layer higher, for the same
 * reason — the user's camera roll is already the local copy and a second copy
 * on an 8 GB device is the one thing a photos app must not do.
 *
 * ## Two facts, two very different jobs
 *
 * `size_bytes` is the **hot-path** check. Every `has()` on an aliased key runs
 * it, and it has to be something a content URI can answer directly.
 *
 * `modification_time` is the **scan-path** check, and cannot be used on the hot
 * path at all: a `ContentProviderFile`'s `lastModified()` is unconditionally
 * `null`, so the only source is a MediaStore query, which is far too expensive
 * per read. The scan job re-queries the store, compares, and re-imports what
 * changed. Storing it here is what makes that comparison possible later.
 *
 * ## What this table must never become
 *
 * An authority on whether bytes exist. It records where to *look*; the media
 * store decides what is actually there, and an alias that no longer resolves
 * demotes its record to `staged` rather than being treated as a blob. See
 * `import-loop-design.md` §2.4 — a stale alias reporting `resident` is how a
 * node comes to believe in a byte that is gone.
 */

import type { StarkeepId } from "@starkeep/protocol-primitives";
import type { RawDatabase } from "@starkeep/storage-adapter";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";

/** One aliased blob: a key whose bytes are an asset in the device media store. */
export interface MediaAlias {
  /** The content-addressed key, meaning exactly what it means on every node. */
  readonly objectStorageKey: string;
  /** The record whose blob this is, so a scan can find what to re-import. */
  readonly recordId: StarkeepId;
  /** `content://media/external/images/media/1234` — what the adapter opens. */
  readonly contentUri: string;
  /** MediaStore id, kept so a moved asset can be re-resolved to a new URI. */
  readonly assetId: string;
  /** Size at import. The hot-path staleness check compares against this. */
  readonly sizeBytes: number;
  /** Advisory MIME, so `stat()` can answer without touching the media store. */
  readonly contentType: string | null;
  /** Media-store mtime at import, or null when it recorded none. */
  readonly modificationTimeMs: number | null;
  readonly addedAtMs: number;
}

export interface MediaAliasStore {
  /** Record an alias. Idempotent on the key — re-importing is not an error. */
  add(alias: MediaAlias): void;
  get(objectStorageKey: string): MediaAlias | null;
  /** Whether this key is aliased at all. Cheaper than `get` on the hot path. */
  isAliased(objectStorageKey: string): boolean;
  /**
   * Forget an alias.
   *
   * Deliberately the *only* removal verb, and it removes a row and nothing
   * else. `delete()` on the overlay adapter routes here, so the eviction pass
   * can run against an aliased key without deleting the user's photograph.
   */
  remove(objectStorageKey: string): void;
  /** Every alias for one record, since an asset can back exactly one. */
  ofRecord(recordId: string): MediaAlias[];
  /** Whether this asset has already been imported, keyed the way a scan asks. */
  byAssetId(assetId: string): MediaAlias | null;
  /** Total aliased bytes — reported by the residency inspector, never budgeted. */
  totalBytes(): number;
  /**
   * A page of aliases, in primary-key order, for a pass that must visit them all.
   *
   * Exists because the EXIF backfill needs *the records this node imported from
   * this device*, and that set lives here rather than in the media store. Its
   * first design walked the media store instead, the way `backfillVideoDurations`
   * does, and could not work: a duration is a fact only the store holds, so that
   * pass has to ask the store — but EXIF is in the file, and this table already
   * names the file. On the handset it was written for the difference is 96 rows
   * against 4,806, with the 96 at the far end of the walk.
   *
   * Ordered by `object_storage_key`, the primary key, because it is the one
   * column with no ties — so a caller paging on it visits every row exactly
   * once. `added_at_ms` would have been the natural choice and is not usable:
   * an import batch stamps many aliases inside one millisecond, so a page could
   * end mid-tie and either repeat the group forever or skip the rest of it.
   */
  listAfter(afterKey: string | null, limit: number): MediaAlias[];
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

const TABLE = "device_media_aliases";

interface Row {
  object_storage_key: string;
  record_id: string;
  content_uri: string;
  asset_id: string;
  size_bytes: number;
  content_type: string | null;
  modification_time_ms: number | null;
  added_at_ms: number;
}

function toAlias(row: Row): MediaAlias {
  return {
    objectStorageKey: row.object_storage_key,
    // SQLite hands back a string; `StarkeepId` is a branded one. This is the
    // boundary where that brand is (re)asserted, and the only place it should
    // be — the ids in this column were branded when the record was created.
    recordId: row.record_id as StarkeepId,
    contentUri: row.content_uri,
    assetId: row.asset_id,
    sizeBytes: row.size_bytes,
    contentType: row.content_type,
    modificationTimeMs: row.modification_time_ms,
    addedAtMs: row.added_at_ms,
  };
}

export function createSqliteMediaAliasStore(options: { readonly db: RawDatabase }): MediaAliasStore {
  const { db } = options;

  db.exec(
    qb.schema
      .createTable(TABLE)
      .ifNotExists()
      .addColumn("object_storage_key", "text", (c) => c.primaryKey())
      .addColumn("record_id", "text", (c) => c.notNull())
      .addColumn("content_uri", "text", (c) => c.notNull())
      .addColumn("asset_id", "text", (c) => c.notNull())
      .addColumn("size_bytes", "integer", (c) => c.notNull())
      .addColumn("content_type", "text")
      .addColumn("modification_time_ms", "integer")
      .addColumn("added_at_ms", "integer", (c) => c.notNull())
      .compile().sql,
  );
  // The scan job's question is "have I already imported this asset", asked once
  // per asset on every scan. Without this it is a full table scan per asset,
  // which is quadratic over a 60k-item library — the shape of bug that is
  // invisible on a dev device with forty photos on it.
  db.exec(
    qb.schema
      .createIndex(`${TABLE}_by_asset`)
      .ifNotExists()
      .on(TABLE)
      .columns(["asset_id"])
      .compile().sql,
  );
  db.exec(
    qb.schema
      .createIndex(`${TABLE}_by_record`)
      .ifNotExists()
      .on(TABLE)
      .columns(["record_id"])
      .compile().sql,
  );

  const addStmt = db.prepare(
    qb
      .insertInto(TABLE)
      .values({
        object_storage_key: sql.raw("?"),
        record_id: sql.raw("?"),
        content_uri: sql.raw("?"),
        asset_id: sql.raw("?"),
        size_bytes: sql.raw("?"),
        content_type: sql.raw("?"),
        modification_time_ms: sql.raw("?"),
        added_at_ms: sql.raw("?"),
      })
      .onConflict((oc) =>
        oc.column("object_storage_key").doUpdateSet((eb) => ({
          // The URI legitimately changes: the same bytes can be re-resolved to
          // a new `content://` after the media store moves an asset between
          // volumes.
          content_uri: eb.ref("excluded.content_uri"),
          asset_id: eb.ref("excluded.asset_id"),
          size_bytes: eb.ref("excluded.size_bytes"),
          content_type: eb.ref("excluded.content_type"),
          modification_time_ms: eb.ref("excluded.modification_time_ms"),
          // `record_id` must be updated too, and the reason is the crash the
          // import loop is built to survive: an import interrupted between the
          // alias write and the record write leaves a row pointing at a record
          // that was never stored. Recovery re-imports the same bytes — same
          // content hash, so same key, so this same row — under a *new* record
          // id, and a row that refused to move would point at the dead one
          // forever. See `importDeviceMedia`'s two-phase note.
          record_id: eb.ref("excluded.record_id"),
        })),
      )
      .compile().sql,
  );

  const getStmt = db.prepare(
    qb.selectFrom(TABLE).selectAll().where("object_storage_key", "=", sql.raw("?")).compile().sql,
  );
  const existsStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .select("object_storage_key")
      .where("object_storage_key", "=", sql.raw("?"))
      .compile().sql,
  );
  const removeStmt = db.prepare(
    qb.deleteFrom(TABLE).where("object_storage_key", "=", sql.raw("?")).compile().sql,
  );
  const ofRecordStmt = db.prepare(
    qb.selectFrom(TABLE).selectAll().where("record_id", "=", sql.raw("?")).compile().sql,
  );
  const byAssetStmt = db.prepare(
    qb.selectFrom(TABLE).selectAll().where("asset_id", "=", sql.raw("?")).compile().sql,
  );
  const totalStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .select(({ fn }) => fn.coalesce(fn.sum<number>("size_bytes"), sql.lit(0)).as("total"))
      .compile().sql,
  );
  const pageStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .selectAll()
      .where("object_storage_key", ">", sql.raw("?"))
      .orderBy("object_storage_key", "asc")
      .limit(sql.raw("?"))
      .compile().sql,
  );
  const firstPageStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .selectAll()
      .orderBy("object_storage_key", "asc")
      .limit(sql.raw("?"))
      .compile().sql,
  );

  return {
    add(alias) {
      addStmt.run(
        alias.objectStorageKey,
        alias.recordId,
        alias.contentUri,
        alias.assetId,
        alias.sizeBytes,
        alias.contentType,
        alias.modificationTimeMs,
        alias.addedAtMs,
      );
    },
    get(objectStorageKey) {
      const row = getStmt.get(objectStorageKey) as Row | undefined;
      return row ? toAlias(row) : null;
    },
    isAliased(objectStorageKey) {
      return existsStmt.get(objectStorageKey) !== undefined;
    },
    remove(objectStorageKey) {
      removeStmt.run(objectStorageKey);
    },
    ofRecord(recordId) {
      return (ofRecordStmt.all(recordId) as Row[]).map(toAlias);
    },
    byAssetId(assetId) {
      const row = byAssetStmt.get(assetId) as Row | undefined;
      return row ? toAlias(row) : null;
    },
    totalBytes() {
      const row = totalStmt.get() as { total: number } | undefined;
      return row?.total ?? 0;
    },
    listAfter(afterKey, limit) {
      const rows = (afterKey === null
        ? firstPageStmt.all(limit)
        : pageStmt.all(afterKey, limit)) as Row[];
      return rows.map(toAlias);
    },
  };
}
