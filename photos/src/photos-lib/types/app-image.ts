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
 * How this image relates to its parent record. `null` for an original, which
 * has no parent.
 *
 * `parentId` says *which* record an image was derived from; this says *how*.
 * The column alone cannot express that, and reading `parentId !== null` as
 * "is a thumbnail" — which the grid used to do — silently mis-rendered every
 * crop as its source's thumbnail. The edge needed a type, not a different
 * home.
 */
export type DerivedKind = "thumbnail" | "crop";

/**
 * App-layer aggregation built from a DataRecord plus the image's metadata row.
 */
export interface AppImage {
  // From DataRecord
  id: string;
  mimeType: string;
  objectStorageKey: string;
  sizeBytes: number;
  createdAt: string; // serialized HLC
  updatedAt: string; // serialized HLC

  /** null for originals; the source record's ID for anything derived. */
  parentId: string | null;

  /**
   * What kind of derived image this is, read from Photos' own label on the
   * record. `null` for an original — and also for a derived image whose label
   * hasn't arrived yet, since a record and its labels share a request but not
   * a transaction. Treating "not yet labelled" as "an original" is the safe
   * direction: it shows a placeholder briefly rather than mis-typing an edge.
   */
  derivedKind: DerivedKind | null;

  /**
   * Resolved renditions, keyed by the pixel size that was **requested**.
   *
   * The client asks the server for target long edges and looks up exactly what
   * it asked for. It never names a size class, and never computes which class
   * it wants — it cannot, because classes are per-record maxima, so a class
   * named for 2560 px holds a 900 px file when its source was 900 px.
   *
   * Empty when the caller did not ask for variants, or when a record has none
   * derived yet. Both read the same way to a consumer: fall back to the inline
   * placeholder.
   */
  variants: Record<string, { url: string; width: number; height: number }>;

  /**
   * Base64 ThumbHash — a ~25-byte inline placeholder, rendered client-side with
   * **zero requests**. Stage zero of progressive presentation: the grid paints
   * every tile before a single byte of image data is fetched.
   */
  thumbHash: string | null;

  // From shared_record_image_metadata
  width: number;
  height: number;
  exif: AppImageExif;

  originalFilename: string;

  /** captured_at metadata (EXIF) when present, falling back to createdAt. */
  effectiveDateTaken: string;

  // User-authored mutable fields (from app-specific syncable table)
  caption?: string | null;
  title?: string | null;
  dateTakenOverride?: string | null;
}
