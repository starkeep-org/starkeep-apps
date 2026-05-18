import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import { sha256Hex } from "../helpers/sha256";
import { buildImageMetadataRow } from "../../data/image-record";
import { extractExif } from "../../metadata/exif-reader";
import { generateThumbnailRecord, type ResizeFunction } from "../../metadata/thumbnail-generator";
import { IMAGE_RECORD_TYPE, PHOTOS_APP_ID } from "../../manifest";
import { assembleAppImage } from "../helpers/assemble-app-image";
import { dataRecordObjectKey, createDataRecord } from "@starkeep/core";

interface UploadBody {
  fileBase64: string;
  mimeType: string;
  provenance: {
    originalFilename: string;
  };
  /** Optional pre-computed dimensions (e.g. supplied by Sharp in cloud handler). */
  imageMeta?: {
    width?: number;
    height?: number;
  };
  /** Optional resize function for thumbnail generation. */
  resizeFn?: ResizeFunction;
}

/**
 * Uploads raw image bytes and creates the image DataRecord + image-metadata
 * row. EXIF + dimensions are extracted from the file bytes — every column in
 * shared_record_image_metadata is deterministically derivable from the file.
 *
 * If a resizeFn is supplied, a thumbnail record is generated inline with
 * `parentId` pointing at the original. The thumbnail also gets its own
 * image-metadata row (dimensions only — no EXIF).
 *
 * Returns the assembled AppImage for the original.
 */
export const uploadImageHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/upload",
  method: "POST",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const body = request.body as Partial<UploadBody> | undefined;
    if (!body?.fileBase64) return { status: 400, body: { error: "fileBase64 is required" } };
    if (!body.mimeType) return { status: 400, body: { error: "mimeType is required" } };
    if (!body.provenance?.originalFilename) {
      return { status: 400, body: { error: "provenance.originalFilename is required" } };
    }

    const fileBytes = base64ToBytes(body.fileBase64);
    const contentHash = await sha256Hex(fileBytes);
    const objectStorageKey = dataRecordObjectKey(IMAGE_RECORD_TYPE, contentHash);

    await context.objectStorageAdapter.put(objectStorageKey, fileBytes, {
      contentType: body.mimeType,
    });

    const exif = await extractExif(fileBytes);
    const dimensions = {
      width: body.imageMeta?.width ?? 0,
      height: body.imageMeta?.height ?? 0,
    };

    const record = createDataRecord(
      {
        type: IMAGE_RECORD_TYPE,
        ownerId: context.ownerId,
        originAppId: PHOTOS_APP_ID,
        contentHash,
        objectStorageKey,
        mimeType: body.mimeType,
        sizeBytes: fileBytes.length,
        originalFilename: body.provenance.originalFilename,
        parentId: null,
      },
      context.clock,
    );
    await context.databaseAdapter.put(record);
    await context.databaseAdapter.putMetadata(IMAGE_RECORD_TYPE, {
      recordId: record.id,
      ...buildImageMetadataRow(dimensions, exif),
    });

    if (body.resizeFn) {
      await generateThumbnailRecord(record, body.resizeFn, {
        databaseAdapter: context.databaseAdapter,
        objectStorageAdapter: context.objectStorageAdapter,
        clock: context.clock,
        ownerId: context.ownerId,
      });
    }

    const image = await assembleAppImage(record, context.databaseAdapter);
    return { status: 201, body: { imageId: record.id as StarkeepId, image } };
  },
};

export { IMAGE_RECORD_TYPE };

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
