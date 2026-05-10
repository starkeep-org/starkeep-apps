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

    // Fetch all image records.
    const queryResult = await context.databaseAdapter.query({
      type: IMAGE_RECORD_TYPE,
      limit: limit * 2, // over-fetch to account for deduplication below
      cursor,
    });

    const allImages = await assembleAppImages(queryResult.records, context.databaseAdapter);

    // Separate thumbnails and originals.
    const allThumbnails = allImages.filter((img) => img.parentId !== "");
    const originals = allImages.filter((img) => img.parentId === "");

    // Deduplicate: if multiple thumbnails exist for the same original (e.g. from
    // a previous bug), only keep the newest one per original.
    const newestByParent = new Map<string, typeof allThumbnails[0]>();
    for (const t of allThumbnails) {
      const existing = newestByParent.get(t.parentId);
      if (!existing || t.effectiveDateTaken > existing.effectiveDateTaken) {
        newestByParent.set(t.parentId, t);
      }
    }
    const thumbnails = Array.from(newestByParent.values());

    // Show each original's thumbnail. Fall back to the original itself when
    // no thumbnail record exists yet (e.g. freshly uploaded).
    const thumbnailedIds = new Set(thumbnails.map((t) => t.parentId));
    const fallbackOriginals = originals.filter((img) => !thumbnailedIds.has(img.id));

    const images = [...thumbnails, ...fallbackOriginals];

    // Sort by effectiveDateTaken descending
    images.sort((a, b) => b.effectiveDateTaken.localeCompare(a.effectiveDateTaken));

    return {
      status: 200,
      body: { images, nextCursor: queryResult.nextCursor },
    };
  },
};
