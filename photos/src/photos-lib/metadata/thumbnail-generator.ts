import type { DataRecord, HLCClock } from "@starkeep/core";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createImageRecord } from "../data/image-record";

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
 * Generates a thumbnail for an original image record and stores it as a new
 * DataRecord with content.parentId pointing to the original.
 *
 * Only call this for originals (records where content.parentId === "").
 * Returns the created thumbnail DataRecord, or null if the original has no file.
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
  const thumbnailKey = `images/thumbnails/${thumbnailHash.slice(0, 2)}/${thumbnailHash}`;

  await context.objectStorageAdapter.put(thumbnailKey, resized.data, {
    contentType: "image/jpeg",
  });

  const thumbnailRecord = createImageRecord({
    mimeType: "image/jpeg",
    objectStorageKey: thumbnailKey,
    contentHash: thumbnailHash,
    sizeBytes: resized.data.length,
    originalFilename: `thumb_${original.originalFilename ?? "image"}`,
    clock: context.clock,
    ownerId: context.ownerId,
    parentId: original.id,
    width: resized.width,
    height: resized.height,
    format: "jpeg",
  });

  await context.databaseAdapter.put(thumbnailRecord);
  return thumbnailRecord;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
