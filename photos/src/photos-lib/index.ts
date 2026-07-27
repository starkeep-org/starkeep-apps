// Types
export type { AppImage, AppImageExif, DerivedKind } from "./types/app-image";

// Cross-app labels Photos writes, and the questions it asks of them
export {
  PHOTOS_APP_ID,
  PHOTOS_LABEL_KEYS,
  derivedKindOf,
  isThumbnail,
  findThumbnailFor,
  canThumbnail,
  type LabelledRecord,
} from "./labels";
export type { GoogleAlbum, GoogleMediaItem } from "./types/google";

// EXIF reader
export { extractExif } from "./metadata/exif-reader";
export type { ExifFields } from "./metadata/exif-generator";
