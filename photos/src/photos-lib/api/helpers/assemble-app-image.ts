import { serializeHLC, type DataRecord, type StarkeepId } from "@starkeep/core";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type { AppImage } from "../../types/app-image";

function assembleFromRecord(record: DataRecord): AppImage {
  const c = record.content as {
    parentId?: string;
    title?: string;
    caption?: string;
    dateTakenOverride?: string | null;
    googlePhotosId?: string | null;
    sourceImageId?: string | null;
    cropX?: number | null;
    cropY?: number | null;
    cropWidth?: number | null;
    cropHeight?: number | null;
    width?: number;
    height?: number;
    format?: string;
    dateTakenRaw?: string | null;
    cameraMake?: string | null;
    cameraModel?: string | null;
    fNumber?: number | null;
    exposureTime?: string | null;
    iso?: number | null;
    lensModel?: string | null;
    gpsLat?: number | null;
    gpsLon?: number | null;
    orientation?: number | null;
  };

  const hasCropRect =
    c.cropX != null && c.cropY != null && c.cropWidth != null && c.cropHeight != null;

  const createdAt = serializeHLC(record.createdAt);
  const effectiveDateTaken = c.dateTakenOverride ?? c.dateTakenRaw ?? createdAt;

  return {
    id: record.id,
    mimeType: record.mimeType ?? "image/jpeg",
    objectStorageKey: record.objectStorageKey ?? "",
    sizeBytes: record.sizeBytes ?? 0,
    createdAt,
    updatedAt: serializeHLC(record.updatedAt),
    parentId: c.parentId ?? "",
    width: c.width ?? 0,
    height: c.height ?? 0,
    format: c.format ?? "unknown",
    exif: {
      dateTakenRaw: c.dateTakenRaw ?? null,
      cameraMake: c.cameraMake ?? null,
      cameraModel: c.cameraModel ?? null,
      fNumber: c.fNumber ?? null,
      exposureTime: c.exposureTime ?? null,
      iso: c.iso ?? null,
      lensModel: c.lensModel ?? null,
      gpsLat: c.gpsLat ?? null,
      gpsLon: c.gpsLon ?? null,
      orientation: c.orientation ?? null,
    },
    originalFilename: record.originalFilename ?? "",
    googlePhotosId: c.googlePhotosId ?? null,
    sourceImageId: c.sourceImageId ?? null,
    cropRect: hasCropRect
      ? { x: c.cropX!, y: c.cropY!, width: c.cropWidth!, height: c.cropHeight! }
      : null,
    caption: c.caption ?? "",
    title: c.title ?? "",
    dateTakenOverride: c.dateTakenOverride ?? null,
    effectiveDateTaken,
  };
}

export async function assembleAppImage(
  record: DataRecord,
  _db: DatabaseAdapter,
): Promise<AppImage> {
  return assembleFromRecord(record);
}

export async function assembleAppImages(
  records: DataRecord[],
  _db: DatabaseAdapter,
): Promise<AppImage[]> {
  return records.map(assembleFromRecord);
}

export function assembleAppImageSync(record: DataRecord): AppImage {
  return assembleFromRecord(record);
}

export { assembleFromRecord as _assembleFromRecord };

// Re-export for callers that import by record alone
export async function assembleAppImageById(
  id: StarkeepId,
  db: DatabaseAdapter,
): Promise<AppImage | null> {
  const record = await db.get(id);
  if (!record) return null;
  return assembleFromRecord(record);
}
