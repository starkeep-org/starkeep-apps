// Types
export type { AppImage, AppImageExif, CropRect } from "./types/app-image";
export type { AlbumFileContent, AppAlbum } from "./types/album";

// Data helpers
export { IMAGE_RECORD_TYPE, createImageRecord } from "./data/image-record";
export {
  ALBUM_RECORD_TYPE,
  ALBUM_MIME_TYPE,
  albumObjectStorageKey,
  createAlbumRecord,
  albumRecordToAppAlbum,
  loadPalFile,
  writePalFile,
  encodePalFile,
  decodePalFile,
} from "./data/album-record";

// Thumbnail generation
export {
  generateThumbnailRecord,
  THUMBNAIL_MAX_WIDTH,
} from "./metadata/thumbnail-generator";
export type { ResizeFunction, ResizeResult } from "./metadata/thumbnail-generator";

// API
export { registerPhotosEndpoints } from "./api/register-endpoints";

// Assembly helpers (for use in route handlers that need to build AppImage outside the SDK)
export { assembleAppImage, assembleAppImages } from "./api/helpers/assemble-app-image";

// App manifest constants and bootstrap
export { PHOTOS_APP_ID, PHOTOS_APP_RECORD_TYPES } from "./manifest";
export { bootstrapPhotosAppPolicies } from "./bootstrap";

// Google Photos types (for use in UI)
export type { GoogleAlbum } from "./api/handlers/list-google-albums";
export type { GoogleMediaItem } from "./api/handlers/list-google-photos";
