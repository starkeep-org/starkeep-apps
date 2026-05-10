export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AppImageExif {
  dateTakenRaw: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  fNumber: number | null;
  exposureTime: string | null;
  iso: number | null;
  lensModel: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
  /** EXIF tag 274 (1–8); used to correct display rotation */
  orientation: number | null;
}

/**
 * App-layer aggregation built from a DataRecord's content fields.
 * NOT a DataRecord subtype — it is an assembled view constructed by API handlers.
 *
 * parentId is "" for original images and the original's ID for thumbnail records.
 * Callers can use parentId === "" to distinguish originals from thumbnails.
 */
export interface AppImage {
  // From DataRecord
  id: string;
  mimeType: string;
  objectStorageKey: string;
  sizeBytes: number;
  createdAt: string; // serialized HLC
  updatedAt: string; // serialized HLC

  // "" for originals; the original's record ID for thumbnails
  parentId: string;

  // Image dimensions (stored in content)
  width: number;
  height: number;
  format: string; // "jpeg" | "png" | "webp" | "unknown"

  // EXIF (stored in content)
  exif: AppImageExif;

  // Provenance (stored in content)
  originalFilename: string;
  googlePhotosId: string | null;
  sourceImageId: string | null;
  cropRect: CropRect | null;

  // User-authored (stored in content)
  caption: string;
  title: string;
  dateTakenOverride: string | null;

  // Computed: dateTakenOverride ?? exif.dateTakenRaw ?? createdAt
  effectiveDateTaken: string;
}
