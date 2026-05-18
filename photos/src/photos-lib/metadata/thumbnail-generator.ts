import { createDataRecord, dataRecordObjectKey, type DataRecord, type HLCClock } from "@starkeep/core";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { buildImageMetadataRow } from "../data/image-record";
import { emptyExif } from "./exif-generator";
import { IMAGE_RECORD_TYPE, PHOTOS_APP_ID } from "../manifest";

export const THUMBNAIL_MAX_WIDTH = 400;

export interface ResizeResult {
  data: Uint8Array;
  width: number;
  height: number;
}

export type ResizeFunction = (
  imageBytes: Uint8Array,
  maxWidth: number,
) => Promise<ResizeResult>;

/**
 * Generates a thumbnail for an original image record and writes it as a new
 * DataRecord whose top-level `parentId` points to the original. Also writes
 * the thumbnail's image-metadata row (dimensions only — thumbnails inherit
 * the original's EXIF semantically; no need to duplicate).
 *
 * Returns the created thumbnail record, or null if the original has no file.
 */
export async function generateThumbnailRecord(
  original: DataRecord,
  resizeFn: ResizeFunction,
  context: {
    databaseAdapter: DatabaseAdapter;
    objectStorageAdapter: ObjectStorageAdapter;
    clock: HLCClock;
    ownerId: string;
  },
): Promise<DataRecord | null> {
  if (!original.objectStorageKey) return null;

  const storageResult = await context.objectStorageAdapter.get(original.objectStorageKey);
  if (!storageResult) return null;

  const imageBytes =
    storageResult.data instanceof Uint8Array
      ? storageResult.data
      : new Uint8Array(storageResult.data as ArrayBuffer);

  const resized = await resizeFn(imageBytes, THUMBNAIL_MAX_WIDTH);

  const thumbnailHash = await sha256Hex(resized.data);
  const thumbnailKey = dataRecordObjectKey(IMAGE_RECORD_TYPE, thumbnailHash);

  await context.objectStorageAdapter.put(thumbnailKey, resized.data, {
    contentType: "image/jpeg",
  });

  const thumbnailRecord = createDataRecord(
    {
      type: IMAGE_RECORD_TYPE,
      ownerId: context.ownerId,
      originAppId: PHOTOS_APP_ID,
      contentHash: thumbnailHash,
      objectStorageKey: thumbnailKey,
      mimeType: "image/jpeg",
      sizeBytes: resized.data.length,
      originalFilename: `thumb_${original.originalFilename ?? "image"}`,
      parentId: original.id,
    },
    context.clock,
  );

  await context.databaseAdapter.put(thumbnailRecord);
  await context.databaseAdapter.putMetadata(IMAGE_RECORD_TYPE, {
    recordId: thumbnailRecord.id,
    ...buildImageMetadataRow(
      { width: resized.width, height: resized.height },
      emptyExif(),
    ),
  });

  return thumbnailRecord;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  );
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
