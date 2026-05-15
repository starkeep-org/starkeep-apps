import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import { IMAGE_RECORD_TYPE } from "../../manifest";
import { assembleAppImages } from "../helpers/assemble-app-image";

export const listImagesHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/list",
  method: "GET",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const query = request.query ?? {};
    const limit = query["limit"] ? parseInt(query["limit"], 10) : 100;
    const cursor = query["cursor"];

    const queryResult = await context.databaseAdapter.query({
      type: IMAGE_RECORD_TYPE,
      limit: limit * 2, // over-fetch to account for thumbnail deduplication below
      cursor,
    });

    const allImages = await assembleAppImages(queryResult.records, context.databaseAdapter);

    // Separate thumbnails (parentId set) from originals (parentId === null).
    const allThumbnails = allImages.filter((img) => img.parentId !== null);
    const originals = allImages.filter((img) => img.parentId === null);

    // Dedupe thumbnails per parent — keep the newest.
    const newestByParent = new Map<string, typeof allThumbnails[0]>();
    for (const t of allThumbnails) {
      const parentId = t.parentId!;
      const existing = newestByParent.get(parentId);
      if (!existing || t.effectiveDateTaken > existing.effectiveDateTaken) {
        newestByParent.set(parentId, t);
      }
    }
    const thumbnails = Array.from(newestByParent.values());

    // Show each original's thumbnail when available; fall back to the original.
    const thumbnailedIds = new Set(thumbnails.map((t) => t.parentId!));
    const fallbackOriginals = originals.filter((img) => !thumbnailedIds.has(img.id));
    const images = [...thumbnails, ...fallbackOriginals];

    images.sort((a, b) => b.effectiveDateTaken.localeCompare(a.effectiveDateTaken));

    return {
      status: 200,
      body: { images, nextCursor: queryResult.nextCursor },
    };
  },
};
