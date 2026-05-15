/** The canonical app ID for the photos app — matches the manifest's `id` field. */
export const PHOTOS_APP_ID = "photos";

/**
 * Core-defined shared type for a raw raster image. Bare name (no namespace) —
 * matches the manifest's sharedTypeAccess entry and the access_grants table.
 */
export const IMAGE_RECORD_TYPE = "image";

/**
 * All record types that the photos app reads and writes.
 * An owner-level SDK must grant policies for each of these before the
 * app-scoped SDK is initialised.
 */
export const PHOTOS_APP_RECORD_TYPES = [IMAGE_RECORD_TYPE] as const;
