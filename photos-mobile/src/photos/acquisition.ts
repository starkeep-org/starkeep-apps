import { acquireRenditions, type AcquisitionEntry } from "@starkeep/photos-ladder";
import type { StarkeepId, DataRecord } from "@starkeep/protocol-primitives";
import type { MobileNode } from "../node";
import { PHOTOS_FILE_PREFIX } from "./app-data";

export async function acquirePhotosRenditions({ photosData, photosEngine, residency,
  databaseAdapter, mediaAliases, localObjectStorage, budgetBytes, requestedKey, maxBytes }: {
  photosData: MobileNode["photosData"];
  photosEngine: MobileNode["photosEngine"];
  residency: MobileNode["residency"];
  databaseAdapter: MobileNode["databaseAdapter"];
  mediaAliases: MobileNode["mediaAliases"];
  localObjectStorage: MobileNode["objectStorage"];
  budgetBytes: number;
  requestedKey?: string;
  maxBytes: number;
}) {
    const entries: AcquisitionEntry[] = [];
    const rows = [...photosData.rows("renditions")];
    const keys = new Set(rows.map(row => row.sub_key));
    for (const row of photosData.localRows()) if (!keys.has(row.sub_key)) rows.push({ ...row });
    const parentIds = [...new Set(rows.map(row => String(row.parent_record_id) as StarkeepId))];
    const parents = new Map<string, DataRecord>();
    const dates = new Map<string, number>();
    for (let offset = 0; offset < parentIds.length; offset += 500) {
      const ids = parentIds.slice(offset, offset + 500);
      const page = await databaseAdapter.query({ filters: [{ field: "id", operator: "in", value: ids }], limit: ids.length });
      for (const record of page.records) parents.set(record.id, record);
      const metadata = await databaseAdapter.getMetadataByIds("image", ids);
      for (const [id, row] of metadata) {
        const captured = Date.parse(String(row.captured_at ?? ""));
        if (Number.isFinite(captured)) dates.set(id, captured);
      }
    }
    for (const row of rows) {
      const key = PHOTOS_FILE_PREFIX + row.sub_key;
      const held = residency?.index.get(key);
      const parent = parents.get(String(row.parent_record_id));
      if (!parent || parent.deletedAt) continue;
      entries.push({ key, sizeClass: String(row.size_class), sizeBytes: Number(row.size_bytes),
        resident: held?.resident ?? await localObjectStorage.has(key),
        lastOpenedAtMs: key === requestedKey ? Date.now() : held?.lastOpenedAtMs ?? null,
        recencyAtMs: dates.get(parent.id) ?? parent.createdAt.wallTime,
        fetchable: !await localObjectStorage.has(parent.objectStorageKey) });
    }
    for (const row of photosData.localRows()) {
      if (parents.has(row.parent_record_id)) continue;
      const key = PHOTOS_FILE_PREFIX + row.sub_key;
      if (!photosData.rows("_starkeep_sync_records", "id", [key]).length) {
        await localObjectStorage.delete(key);
        residency?.index.markDeparted(key);
      }
      photosData.removeLocal(row);
    }
    const result = await acquireRenditions({ entries,
      budgetBytes,
      requestedKey, prefetch: requestedKey === undefined, maxBytes,
      drop: async key => {
        await localObjectStorage.delete(key);
        residency?.index.markDeparted(key);
        return true;
      },
      fetch: async key => {
        if (!photosEngine) return false;
        const row = photosData.rows("_starkeep_sync_records", "id", [key])[0];
        if (!row) return false;
        const result = await photosEngine.acquireBlob({ fileHash: String(row.content_hash), objectStorageKey: key,
          sizeBytes: Number(row.size_bytes), mimeType: String(row.mime_type) },
          { recordId: key, objectStorageKey: key, sizeBytes: Number(row.size_bytes),
            type: String(row.mime_type), parentId: null, appId: "photos", originAppId: "photos",
            recencyAtMs: null, lastOpenedAtMs: key === requestedKey ? Date.now() : null }, "request");
        return result.outcome === "landed";
      },
    });
    if (requestedKey) residency?.index.markOpened(requestedKey, Date.now());
    return result;
}
