import type { ApiRouter } from "@starkeep/shared-space-api";
import { listImagesHandler } from "./handlers/list-images";
import { getImageHandler } from "./handlers/get-image";
import { uploadImageHandler } from "./handlers/upload-image";
import { deleteImageHandler } from "./handlers/delete-image";
import { getThumbnailHandler } from "./handlers/get-thumbnail";
import { listGoogleAlbumsHandler } from "./handlers/list-google-albums";
import { listGooglePhotosHandler } from "./handlers/list-google-photos";
import { importGooglePhotoHandler } from "./handlers/import-google-photo";

export function registerPhotosEndpoints(router: ApiRouter): void {
  router.register(listImagesHandler);
  router.register(getImageHandler);
  router.register(uploadImageHandler);
  router.register(deleteImageHandler);
  router.register(getThumbnailHandler);
  router.register(listGoogleAlbumsHandler);
  router.register(listGooglePhotosHandler);
  router.register(importGooglePhotoHandler);
}
