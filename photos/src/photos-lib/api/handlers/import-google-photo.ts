import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import { sha256Hex } from "../helpers/sha256";
import { createImageRecord } from "../../data/image-record";
import { generateThumbnailRecord, type ResizeFunction } from "../../metadata/thumbnail-generator";

interface ImportBody {
  accessToken: string;
  mediaItemId: string;
  resizeFn?: ResizeFunction;
}

/**
 * Downloads a photo from Google Photos and imports it as a @starkeep/image record.
 * All provenance and user-authored fields are stored directly in content.
 * If resizeFn is provided in the request body, a thumbnail DataRecord is created inline.
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

    // Fetch media item metadata from Google Photos API
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
      mediaMetadata?: { creationTime?: string };
    };

    // Download the full-resolution image bytes
    const downloadResponse = await fetch(`${meta.baseUrl}=d`);
    if (!downloadResponse.ok) {
      return { status: 502, body: { error: "Failed to download image from Google Photos" } };
    }

    const fileBytes = new Uint8Array(await downloadResponse.arrayBuffer());
    const contentHash = await sha256Hex(fileBytes);
    const objectStorageKey = `images/${contentHash.slice(0, 2)}/${contentHash}`;

    await context.objectStorageAdapter.put(objectStorageKey, fileBytes, {
      contentType: meta.mimeType,
    });

    const originalFilename = meta.filename;
    const record = createImageRecord({
      mimeType: meta.mimeType,
      objectStorageKey,
      contentHash,
      sizeBytes: fileBytes.length,
      originalFilename,
      clock: context.clock,
      ownerId: context.ownerId,
      parentId: "",
      title: originalFilename.replace(/\.[^.]+$/, ""),
      caption: "",
      googlePhotosId: meta.id,
    });

    await context.databaseAdapter.put(record);

    // Generate thumbnail if a resize function is provided
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
