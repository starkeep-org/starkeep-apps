export interface AppImageExif {
  capturedAt: string | null;
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
 * App-layer aggregation built from a DataRecord plus the image's metadata row.
 *
 * `parentId === null` distinguishes originals from thumbnails (whose parent is
 * the original they were derived from).
 */
export interface AppImage {
  // From DataRecord
  id: string;
  mimeType: string;
  objectStorageKey: string;
  sizeBytes: number;
  createdAt: string; // serialized HLC
  updatedAt: string; // serialized HLC

  /** null for originals; the original record's ID for thumbnails. */
  parentId: string | null;

  // From shared_record_image_metadata
  width: number;
  height: number;
  exif: AppImageExif;

  originalFilename: string;

  /** captured_at metadata (EXIF) when present, falling back to createdAt. */
  effectiveDateTaken: string;

  // User-authored mutable fields (from app-specific syncable table)
  title?: string | null;
  dateTakenOverride?: string | null;
}
