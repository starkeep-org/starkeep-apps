import type { AppImage } from "@/photos-lib";
import type { PhotoRecord, PhotoMetadataRow, ImageEnriched } from "./data-server-client";

export function photoRecordToAppImage(
  record: PhotoRecord,
  metadata: PhotoMetadataRow | null,
  enriched?: ImageEnriched | null,
): AppImage {
  const capturedAt = metadata?.captured_at ?? null;
  const overrideDate = enriched?.date_taken_override ?? null;
  return {
    id: record.id,
    mimeType: record.mime_type ?? "image/jpeg",
    objectStorageKey: record.object_storage_key,
    sizeBytes: record.size_bytes,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    parentId: record.parent_id,
    width: metadata?.width ?? 0,
    height: metadata?.height ?? 0,
    exif: {
      capturedAt,
      cameraMake: metadata?.camera_make ?? null,
      cameraModel: metadata?.camera_model ?? null,
      fNumber: metadata?.f_number ?? null,
      exposureTime: metadata?.exposure_time ?? null,
      iso: metadata?.iso ?? null,
      lensModel: metadata?.lens_model ?? null,
      gpsLat: metadata?.gps_lat ?? null,
      gpsLon: metadata?.gps_lon ?? null,
      orientation: metadata?.orientation ?? null,
    },
    originalFilename: record.original_filename ?? record.id,
    effectiveDateTaken: overrideDate ?? capturedAt ?? record.created_at,
    caption: enriched?.caption ?? null,
    title: enriched?.title ?? null,
    dateTakenOverride: overrideDate,
  };
}
