// Types
export type { AppImage, AppImageExif } from "./types/app-image";

// Data helpers
export { IMAGE_RECORD_TYPE } from "./data/image-record";

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

// EXIF reader
export { extractExif } from "./metadata/exif-reader";
export type { ExifFields } from "./metadata/exif-generator";

// App manifest constants and bootstrap
export { PHOTOS_APP_ID, PHOTOS_APP_RECORD_TYPES } from "./manifest";
export { bootstrapPhotosApp } from "./bootstrap";

// Google Photos types (for use in UI)
export type { GoogleAlbum } from "./api/handlers/list-google-albums";
export type { GoogleMediaItem } from "./api/handlers/list-google-photos";
