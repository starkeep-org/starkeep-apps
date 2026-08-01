import type { AppImage } from "@/photos-lib";
import { derivedKindOf } from "@/photos-lib";
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
    derivedKind: derivedKindOf(record),
    // Passed through verbatim: the server resolved these, keyed by the sizes
    // this client asked for. Re-keying them by anything else here would put a
    // size-class assumption back into the consumer.
    // Only variants that actually carry a URL are usable for display. One that
    // arrived without one means the caller may not read it — the server omits
    // the URL rather than omitting the entry, so that "cannot read this" is
    // distinguishable from "no rendition that size".
    variants: Object.fromEntries(
      Object.entries(record.variants ?? {})
        .filter(([, v]) => typeof v.url === "string")
        .map(([target, v]) => [target, { url: v.url!, width: v.width, height: v.height }]),
    ),
    thumbHash: metadata?.thumb_hash ?? null,
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
