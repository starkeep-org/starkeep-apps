import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import { IMAGE_RECORD_TYPE } from "../../manifest";

/**
 * Serves the thumbnail file for a given original image ID. The thumbnail
 * record is identified by `parentId === <originalId>` on the records table.
 */
export const getThumbnailHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/thumbnail",
  method: "GET",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const id = request.query?.["id"];
    if (!id) return { status: 400, body: { error: "id query parameter is required" } };

    const result = await context.databaseAdapter.query({
      type: IMAGE_RECORD_TYPE,
      filters: [{ field: "parentId", operator: "eq", value: id }],
      limit: 1,
    });

    const thumbnailRecord = result.records[0];
    if (!thumbnailRecord?.objectStorageKey) {
      return { status: 404, body: { error: "Thumbnail not yet generated" } };
    }

    const storageResult = await context.objectStorageAdapter.get(thumbnailRecord.objectStorageKey);
    if (!storageResult) {
      return { status: 404, body: { error: "Thumbnail file not found in storage" } };
    }

    const bytes =
      storageResult.data instanceof Uint8Array
        ? storageResult.data
        : new Uint8Array(storageResult.data as ArrayBuffer);

    return {
      status: 200,
      body: {
        thumbnailBase64: bytesToBase64(bytes),
        contentType: thumbnailRecord.mimeType ?? "image/jpeg",
      },
    };
  },
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
