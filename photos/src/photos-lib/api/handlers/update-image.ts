import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import { assembleAppImage } from "../helpers/assemble-app-image";

interface UpdateBody {
  id: string;
  caption?: string;
  title?: string;
  dateTakenOverride?: string | null;
}

/**
 * Updates user-authored fields (caption, title, dateTakenOverride) for an
 * original image. Reads existing values from content and merges before writing.
 */
export const updateImageHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/item",
  method: "PATCH",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const body = request.body as Partial<UpdateBody> | undefined;
    if (!body?.id) return { status: 400, body: { error: "id is required" } };

    const record = await context.databaseAdapter.get(body.id as StarkeepId);
    if (!record) return { status: 404, body: { error: "Image not found" } };

    const c = record.content as {
      caption?: string;
      title?: string;
      dateTakenOverride?: string | null;
      [key: string]: unknown;
    };

    const updatedRecord = {
      ...record,
      content: {
        ...c,
        caption: body.caption !== undefined ? body.caption : (c.caption ?? ""),
        title: body.title !== undefined ? body.title : (c.title ?? ""),
        dateTakenOverride:
          body.dateTakenOverride !== undefined
            ? body.dateTakenOverride
            : (c.dateTakenOverride ?? null),
      },
      updatedAt: context.clock.now(),
      version: record.version + 1,
    };

    await context.databaseAdapter.put(updatedRecord);

    const image = await assembleAppImage(updatedRecord, context.databaseAdapter);
    return { status: 200, body: { image } };
  },
};
