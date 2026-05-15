import { serializeHLC, type DataRecord, type MetadataRow, type StarkeepId } from "@starkeep/core";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type { AppImage, AppImageExif } from "../../types/app-image";
import { IMAGE_RECORD_TYPE } from "../../manifest";

function emptyExif(): AppImageExif {
  return {
    capturedAt: null,
    cameraMake: null,
    cameraModel: null,
    fNumber: null,
    exposureTime: null,
    iso: null,
    lensModel: null,
    gpsLat: null,
    gpsLon: null,
    orientation: null,
  };
}

function exifFromMetadata(row: MetadataRow | null): AppImageExif {
  if (!row) return emptyExif();
  return {
    capturedAt: (row["captured_at"] as string | null) ?? null,
    cameraMake: (row["camera_make"] as string | null) ?? null,
    cameraModel: (row["camera_model"] as string | null) ?? null,
    fNumber: (row["f_number"] as number | null) ?? null,
    exposureTime: (row["exposure_time"] as string | null) ?? null,
    iso: (row["iso"] as number | null) ?? null,
    lensModel: (row["lens_model"] as string | null) ?? null,
    gpsLat: (row["gps_lat"] as number | null) ?? null,
    gpsLon: (row["gps_lon"] as number | null) ?? null,
    orientation: (row["orientation"] as number | null) ?? null,
  };
}

function assemble(record: DataRecord, metadata: MetadataRow | null): AppImage {
  const createdAt = serializeHLC(record.createdAt);
  const exif = exifFromMetadata(metadata);
  const width = (metadata?.["width"] as number | null) ?? 0;
  const height = (metadata?.["height"] as number | null) ?? 0;

  return {
    id: record.id,
    mimeType: record.mimeType,
    objectStorageKey: record.objectStorageKey,
    sizeBytes: record.sizeBytes,
    createdAt,
    updatedAt: serializeHLC(record.updatedAt),
    parentId: record.parentId ?? null,
    width,
    height,
    exif,
    originalFilename: record.originalFilename ?? "",
    effectiveDateTaken: exif.capturedAt ?? createdAt,
  };
}

export async function assembleAppImage(
  record: DataRecord,
  db: DatabaseAdapter,
): Promise<AppImage> {
  const metadata = await db.getMetadata(IMAGE_RECORD_TYPE, record.id);
  return assemble(record, metadata);
}

export async function assembleAppImages(
  records: DataRecord[],
  db: DatabaseAdapter,
): Promise<AppImage[]> {
  if (records.length === 0) return [];
  const metadataMap = await db.getMetadataByIds(
    IMAGE_RECORD_TYPE,
    records.map((r) => r.id),
  );
  return records.map((record) => assemble(record, metadataMap.get(record.id) ?? null));
}

export async function assembleAppImageById(
  id: StarkeepId,
  db: DatabaseAdapter,
): Promise<AppImage | null> {
  const record = await db.get(id);
  if (!record) return null;
  return assembleAppImage(record, db);
}
