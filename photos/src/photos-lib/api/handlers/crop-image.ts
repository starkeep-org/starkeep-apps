import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import { sha256Hex } from "../helpers/sha256";
import { createImageRecord } from "../../data/image-record";
import { generateThumbnailRecord, type ResizeFunction } from "../../metadata/thumbnail-generator";
import { assembleAppImage } from "../helpers/assemble-app-image";

interface CropBody {
  sourceImageId: string;
  cropRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  cropImageBytes?: (
    src: Uint8Array,
    x: number,
    y: number,
    w: number,
    h: number,
  ) => Promise<Uint8Array>;
  resizeFn?: ResizeFunction;
}

/**
 * Crops an image server-side and stores the result as a new original image record
 * (content.parentId = ""). Provenance links back to the source image via
 * content.sourceImageId. A thumbnail record is generated if resizeFn is provided.
 */
export const cropImageHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/crop",
  method: "POST",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const body = request.body as Partial<CropBody> | undefined;

    if (!body?.sourceImageId) return { status: 400, body: { error: "sourceImageId is required" } };
    if (!body.cropRect) return { status: 400, body: { error: "cropRect is required" } };
    if (!body.cropImageBytes) return { status: 400, body: { error: "cropImageBytes function is required" } };

    const { x, y, width, height } = body.cropRect;
    if (width <= 0 || height <= 0) {
      return { status: 400, body: { error: "cropRect width and height must be positive" } };
    }

    const sourceRecord = await context.databaseAdapter.get(body.sourceImageId as StarkeepId);
    if (!sourceRecord?.objectStorageKey) {
      return { status: 404, body: { error: "Source image not found" } };
    }

    const storageResult = await context.objectStorageAdapter.get(sourceRecord.objectStorageKey);
    if (!storageResult) {
      return { status: 404, body: { error: "Source image file not found" } };
    }

    const srcBytes =
      storageResult.data instanceof Uint8Array
        ? storageResult.data
        : new Uint8Array(storageResult.data as ArrayBuffer);

    const croppedBytes = await body.cropImageBytes(srcBytes, x, y, width, height);
    const contentHash = await sha256Hex(croppedBytes);
    const objectStorageKey = `images/${contentHash.slice(0, 2)}/${contentHash}`;

    await context.objectStorageAdapter.put(objectStorageKey, croppedBytes, {
      contentType: "image/jpeg",
    });

    const sourceContent = sourceRecord.content as {
      originalFilename?: string;
      title?: string;
      [key: string]: unknown;
    };
    const sourceFilename = sourceRecord.originalFilename ?? sourceContent.originalFilename ?? "image";
    const sourceTitle = sourceContent.title ?? sourceFilename.replace(/\.[^.]+$/, "");

    const newRecord = createImageRecord({
      mimeType: "image/jpeg",
      objectStorageKey,
      contentHash,
      sizeBytes: croppedBytes.length,
      originalFilename: `crop_of_${sourceFilename}`,
      clock: context.clock,
      ownerId: context.ownerId,
      parentId: "",
      title: `Crop of ${sourceTitle}`,
      caption: "",
      sourceImageId: body.sourceImageId,
      cropX: x,
      cropY: y,
      cropWidth: width,
      cropHeight: height,
    });

    await context.databaseAdapter.put(newRecord);

    // Generate thumbnail for the cropped image if resize function is provided
    if (body.resizeFn) {
      await generateThumbnailRecord(newRecord, body.resizeFn, {
        databaseAdapter: context.databaseAdapter,
        objectStorageAdapter: context.objectStorageAdapter,
        clock: context.clock,
        ownerId: context.ownerId,
      });
    }

    const image = await assembleAppImage(newRecord, context.databaseAdapter);
    return { status: 201, body: { imageId: newRecord.id as string, image } };
  },
};
