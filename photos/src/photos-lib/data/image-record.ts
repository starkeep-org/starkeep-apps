import { createDataRecord, type DataRecord, type HLCClock } from "@starkeep/core";
import { IMAGE_RECORD_TYPE } from "../manifest";

export { IMAGE_RECORD_TYPE };

export function createImageRecord(options: {
  mimeType: string;
  objectStorageKey: string;
  contentHash: string;
  sizeBytes: number;
  originalFilename: string;
  clock: HLCClock;
  ownerId: string;
  /** "" for originals; the original's record ID for thumbnails */
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
}): DataRecord {
  return createDataRecord(
    {
      type: IMAGE_RECORD_TYPE,
      ownerId: options.ownerId,
      contentHash: options.contentHash,
      objectStorageKey: options.objectStorageKey,
      mimeType: options.mimeType,
      sizeBytes: options.sizeBytes,
      originalFilename: options.originalFilename,
      content: {
        parentId: options.parentId ?? "",
        title: options.title ?? "",
        caption: options.caption ?? "",
        dateTakenOverride: options.dateTakenOverride ?? null,
        googlePhotosId: options.googlePhotosId ?? null,
        sourceImageId: options.sourceImageId ?? null,
        cropX: options.cropX ?? null,
        cropY: options.cropY ?? null,
        cropWidth: options.cropWidth ?? null,
        cropHeight: options.cropHeight ?? null,
        width: options.width ?? 0,
        height: options.height ?? 0,
        format: options.format ?? "unknown",
        dateTakenRaw: options.dateTakenRaw ?? null,
        cameraMake: options.cameraMake ?? null,
        cameraModel: options.cameraModel ?? null,
        fNumber: options.fNumber ?? null,
        exposureTime: options.exposureTime ?? null,
        iso: options.iso ?? null,
        lensModel: options.lensModel ?? null,
        gpsLat: options.gpsLat ?? null,
        gpsLon: options.gpsLon ?? null,
        orientation: options.orientation ?? null,
      },
    },
    options.clock,
  );
}
