import { serializeHLC, type HLCClock } from "@starkeep/protocol-primitives";
import type {
  RawDatabase,
  ObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import {
  createAppSyncableTables,
  createReservedFileRecordsTable,
  appSyncableTableInfo,
  withFileRecordsTable,
  upsertAppSyncableNamespace,
  SqliteAppSyncableNamespaceStore,
  SqliteAppSyncableApplier,
  sqliteCompiler as qb,
  appSyncableTableName,
  type DeclaredSyncableTable,
} from "@starkeep/storage-sqlite";
import manifest from "../../../photos/starkeep.manifest.json";

export const PHOTOS_ID = manifest.id;
export const PHOTOS_FILE_PREFIX = `apps/${PHOTOS_ID}/syncable/`;
export interface RenditionRow {
  parent_record_id: string;
  size_class: string;
  sub_key: string;
  content_hash: string;
  width: number;
  height: number;
  size_bytes: number;
  content_type: string;
}
export interface RenditionCandidate {
  id: string;
  objectStorageKey: string;
  labelValue: string;
  width: number;
  height: number;
  type: string;
}

/** The handset consumes the same declaration and DDL as the installers. */
export function createPhotosAppData(db: RawDatabase, clock: HLCClock) {
  const tables = manifest.infraRequirements.appSpecificSyncable
    .tables as DeclaredSyncableTable[];
  createAppSyncableTables(db, PHOTOS_ID, tables);
  createReservedFileRecordsTable(db, PHOTOS_ID);
  upsertAppSyncableNamespace(
    db,
    PHOTOS_ID,
    withFileRecordsTable(
      tables.map((t) => appSyncableTableInfo(t.name, t.columns)),
      true,
    ),
    true,
  );
  const namespaces = new SqliteAppSyncableNamespaceStore(db);
  const applier = new SqliteAppSyncableApplier(db, namespaces);
  const source = {
    namespaces: {
      get: (id: string) => (id === PHOTOS_ID ? namespaces.get(id) : null),
      list: () => namespaces.list().filter((ns) => ns.appId === PHOTOS_ID),
    },
    applier,
  };
  function rows(table: string, column?: string, values?: readonly string[]) {
    let query = qb
      .selectFrom(appSyncableTableName(PHOTOS_ID, table))
      .selectAll()
      .where("deleted_at", "is", null);
    if (column) query = query.where(column, "in", [...values!]);
    const compiled = query.compile();
    return db
      .prepare(compiled.sql)
      .all(...(compiled.parameters as string[])) as Record<string, unknown>[];
  }
  function write(table: string, row: Record<string, unknown>) {
    const timestamp = clock.now();
    applier.apply({
      appId: PHOTOS_ID,
      table,
      op: "insert",
      timestamp,
      row: { ...row, updated_at: serializeHLC(timestamp), deleted_at: null },
    });
  }
  return {
    source,
    rows,
    write,
    candidates(
      parentIds: readonly string[],
    ): Map<string, RenditionCandidate[]> {
      const out = new Map<string, RenditionCandidate[]>();
      if (!parentIds.length) return out;
      for (const row of rows("renditions", "parent_record_id", parentIds)) {
        const parent = String(row.parent_record_id);
        const key = PHOTOS_FILE_PREFIX + row.sub_key;
        const candidates = out.get(parent) ?? [];
        candidates.push({
          id: key,
          objectStorageKey: key,
          labelValue: String(row.size_class),
          width: Number(row.width),
          height: Number(row.height),
          type: String(row.content_type),
        });
        out.set(parent, candidates);
      }
      return out;
    },
    async publish(
      row: RenditionRow,
      bytes: Uint8Array,
      storage: ObjectStorageAdapter,
    ) {
      // Recheck after encoding. A live winner keeps its immutable URL.
      if (
        rows("renditions", "parent_record_id", [row.parent_record_id]).some(
          (r) => r.size_class === row.size_class,
        )
      )
        return false;
      const key = PHOTOS_FILE_PREFIX + row.sub_key;
      await storage.put(key, bytes, { contentType: row.content_type });
      write("_starkeep_sync_records", {
        id: key,
        object_storage_key: key,
        content_hash: row.content_hash,
        mime_type: row.content_type,
        size_bytes: row.size_bytes,
        original_filename: row.sub_key.split("/").at(-1),
        origin_app_id: PHOTOS_ID,
        created_at: serializeHLC(clock.now()),
      });
      write("renditions", { ...row });
      return true;
    },
  };
}
export type PhotosAppData = ReturnType<typeof createPhotosAppData>;
