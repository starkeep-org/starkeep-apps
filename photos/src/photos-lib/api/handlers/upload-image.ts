import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import { sha256Hex } from "../helpers/sha256";
import { createImageRecord } from "../../data/image-record";
import { generateThumbnailRecord, type ResizeFunction } from "../../metadata/thumbnail-generator";
import { IMAGE_RECORD_TYPE } from "../../manifest";
import { assembleAppImage } from "../helpers/assemble-app-image";

interface UploadBody {
  fileBase64: string;
  mimeType: string;
  provenance: {
    originalFilename: string;
    googlePhotosId?: string | null;
    sourceImageId?: string | null;
    cropX?: number | null;
    cropY?: number | null;
    cropWidth?: number | null;
    cropHeight?: number | null;
  };
  userAuthored: {
    title: string;
    caption: string;
  };
  /** Optional: inject a resize function for thumbnail generation */
  resizeFn?: ResizeFunction;
  /** Optional: image dimensions pre-computed by the caller */
  imageMeta?: {
    width?: number;
    height?: number;
    format?: string;
    dateTakenRaw?: string | null;
    cameraMake?: string | null;
    cameraModel?: string | null;
    fNumber?: number | null;
    exposureTime?: string | null;
    iso?: number | null;
    lensModel?: string | null;
    gpsLat?: number | null;
    gpsLon?: number | null;
    orientation?: number | null;
  };
}

/**
 * Stores raw image bytes and creates a DataRecord for the original image.
 * All metadata (provenance, user-authored, dimensions, EXIF) is stored directly
 * in the record's content field.
 *
 * If a resizeFn is provided in the request body, a thumbnail DataRecord is
 * generated inline and stored with content.parentId pointing to the original.
 * Images that already have a parentId set are never thumbnailed.
 *
 * Returns { imageId } of the original record.
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
    const objectStorageKey = `images/${contentHash.slice(0, 2)}/${contentHash}`;

    await context.objectStorageAdapter.put(objectStorageKey, fileBytes, {
      contentType: body.mimeType,
    });

    const defaultTitle = body.provenance.originalFilename.replace(/\.[^.]+$/, "");
    const meta = body.imageMeta ?? {};

    const record = createImageRecord({
      mimeType: body.mimeType,
      objectStorageKey,
      contentHash,
      sizeBytes: fileBytes.length,
      originalFilename: body.provenance.originalFilename,
      clock: context.clock,
      ownerId: context.ownerId,
      parentId: "",
      title: body.userAuthored?.title || defaultTitle,
      caption: body.userAuthored?.caption ?? "",
      dateTakenOverride: null,
      googlePhotosId: body.provenance.googlePhotosId ?? null,
      sourceImageId: body.provenance.sourceImageId ?? null,
      cropX: body.provenance.cropX ?? null,
      cropY: body.provenance.cropY ?? null,
      cropWidth: body.provenance.cropWidth ?? null,
      cropHeight: body.provenance.cropHeight ?? null,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      format: meta.format ?? "unknown",
      dateTakenRaw: meta.dateTakenRaw ?? null,
      cameraMake: meta.cameraMake ?? null,
      cameraModel: meta.cameraModel ?? null,
      fNumber: meta.fNumber ?? null,
      exposureTime: meta.exposureTime ?? null,
      iso: meta.iso ?? null,
      lensModel: meta.lensModel ?? null,
      gpsLat: meta.gpsLat ?? null,
      gpsLon: meta.gpsLon ?? null,
      orientation: meta.orientation ?? null,
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

    // Return the assembled original image so callers have full AppImage data
    const image = await assembleAppImage(record, context.databaseAdapter);
    return { status: 201, body: { imageId: record.id as string, image } };
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
