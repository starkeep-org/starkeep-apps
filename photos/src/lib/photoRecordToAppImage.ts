import type { AppImage } from "@/photos-lib";
import type { PhotoRecord } from "./data-server-client";

export function photoRecordToAppImage(record: PhotoRecord): AppImage {
  // The data-server returns record.content as `payload` in all REST responses.
  const p = record.payload ?? {};
  return {
    id: record.id,
    mimeType: record.mime_type ?? "image/jpeg",
    objectStorageKey: record.object_storage_key ?? "",
    sizeBytes: record.size_bytes ?? 0,
    createdAt: record.created_at ?? new Date().toISOString(),
    updatedAt: record.updated_at ?? new Date().toISOString(),
    parentId: String(p.parentId ?? ""),
    width: Number(p.width ?? 0),
    height: Number(p.height ?? 0),
    format: String(p.format ?? "unknown"),
    exif: {
      dateTakenRaw: p.dateTakenRaw ?? null,
      cameraMake: p.cameraMake ?? null,
      cameraModel: p.cameraModel ?? null,
      fNumber: p.fNumber ?? null,
      exposureTime: p.exposureTime ?? null,
      iso: p.iso ?? null,
      lensModel: p.lensModel ?? null,
      gpsLat: p.gpsLat ?? null,
      gpsLon: p.gpsLon ?? null,
      orientation: p.orientation ?? null,
    },
    originalFilename: record.original_filename ?? String(p.fileName ?? record.id),
    googlePhotosId: (p.googlePhotosId as string | null) ?? null,
    sourceImageId: (p.sourceImageId as string | null) ?? null,
    cropRect: (p.cropRect as AppImage["cropRect"]) ?? null,
    caption: String(p.caption ?? ""),
    title: String(p.title ?? p.fileName ?? record.id),
    dateTakenOverride: p.dateTakenOverride ?? null,
    effectiveDateTaken:
      p.dateTakenOverride ??
      p.dateTakenRaw ??
      record.created_at ??
      record.updated_at ??
      new Date().toISOString(),
  };
}
