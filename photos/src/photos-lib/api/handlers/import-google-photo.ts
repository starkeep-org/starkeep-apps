import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import { sha256Hex } from "../helpers/sha256";
import { createDataRecord, dataRecordObjectKey } from "@starkeep/core";
import { buildImageMetadataRow } from "../../data/image-record";
import { extractExif } from "../../metadata/exif-reader";
import { generateThumbnailRecord, type ResizeFunction } from "../../metadata/thumbnail-generator";
import { IMAGE_RECORD_TYPE, PHOTOS_APP_ID } from "../../manifest";

interface ImportBody {
  accessToken: string;
  mediaItemId: string;
  resizeFn?: ResizeFunction;
}

/**
 * Downloads a photo from Google Photos and imports it as an `image` record.
 * Image metadata is extracted from the downloaded bytes (EXIF + dimensions).
 * Google Photos-specific provenance (mediaItemId etc.) is not persisted —
 * that's app-specific data which is out of scope.
 */
export const importGooglePhotoHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/google/import",
  method: "POST",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const body = request.body as Partial<ImportBody> | undefined;
    if (!body?.accessToken) return { status: 400, body: { error: "accessToken is required" } };
    if (!body.mediaItemId) return { status: 400, body: { error: "mediaItemId is required" } };

    const metaResponse = await fetch(
      `https://photoslibrary.googleapis.com/v1/mediaItems/${body.mediaItemId}`,
      { headers: { Authorization: `Bearer ${body.accessToken}` } },
    );

    if (!metaResponse.ok) {
      const text = await metaResponse.text();
      return { status: metaResponse.status, body: { error: `Google API error: ${text}` } };
    }

    const meta = (await metaResponse.json()) as {
      id: string;
      filename: string;
      mimeType: string;
      baseUrl: string;
    };

    const downloadResponse = await fetch(`${meta.baseUrl}=d`);
    if (!downloadResponse.ok) {
      return { status: 502, body: { error: "Failed to download image from Google Photos" } };
    }

    const fileBytes = new Uint8Array(await downloadResponse.arrayBuffer());
    const contentHash = await sha256Hex(fileBytes);
    const objectStorageKey = dataRecordObjectKey(IMAGE_RECORD_TYPE, contentHash);

    await context.objectStorageAdapter.put(objectStorageKey, fileBytes, {
      contentType: meta.mimeType,
    });

    const exif = await extractExif(fileBytes);

    const record = createDataRecord(
      {
        type: IMAGE_RECORD_TYPE,
        ownerId: context.ownerId,
        originAppId: PHOTOS_APP_ID,
        contentHash,
        objectStorageKey,
        mimeType: meta.mimeType,
        sizeBytes: fileBytes.length,
        originalFilename: meta.filename,
        parentId: null,
      },
      context.clock,
    );

    await context.databaseAdapter.put(record);
    await context.databaseAdapter.putMetadata(IMAGE_RECORD_TYPE, {
      recordId: record.id,
      ...buildImageMetadataRow({ width: 0, height: 0 }, exif),
    });

    if (body.resizeFn) {
      await generateThumbnailRecord(record, body.resizeFn, {
        databaseAdapter: context.databaseAdapter,
        objectStorageAdapter: context.objectStorageAdapter,
        clock: context.clock,
        ownerId: context.ownerId,
      });
    }

    return { status: 201, body: { imageId: record.id as string } };
  },
};
