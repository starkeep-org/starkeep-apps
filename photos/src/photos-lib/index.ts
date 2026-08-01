// Types
export type { AppImage, AppImageExif, DerivedKind } from "./types/app-image";

// Cross-app labels Photos writes, and the questions it asks of them
export {
  PHOTOS_APP_ID,
  PHOTOS_LABEL_KEYS,
  LABEL_VALUE_MAX_BYTES,
  LABEL_VALUES_PER_KEY_MAX,
  derivedKindOf,
  isThumbnail,
  findThumbnailFor,
  canThumbnail,
  precheckThumbnail,
  renditionClassOf,
  THUMBNAIL_SIZE_CLASS,
  type LabelledRecord,
  type ThumbnailPrecheck,
} from "./labels";
export {
  STILL_LADDER,
  VIDEO_LADDER,
  DEFAULT_DISABLED_CLASSES,
  SKIM_MIN_SPEED,
  SKIM_TARGET_SECONDS,
  SKIM_FPS,
  applicableStillClasses,
  applicableVideoClasses,
  renditionLongEdge,
  topApplicableStillClass,
  isOwnTopOfLadder,
  transcodeWouldChangeAnything,
  skimSpeedFactor,
  type SizeClass,
  type StillClassSpec,
  type VideoClassSpec,
  type VideoSource,
} from "./ladder";
export {
  deriveStillLadder,
  readSourceDimensions,
  computeThumbHash,
  computePerceptualHash,
  perceptualDistance,
  missingRenditionClasses,
  ladderIsComplete,
  cloudCanDecode,
  CLOUD_DECODABLE_TYPES,
  type DerivedRendition,
  type DeriveLadderOptions,
} from "./image-processing/derive-ladder";
export {
  publishRendition,
  existingRenditionClasses,
  publishThumbHash,
  assertLadderComplete,
  RenditionPublishError,
  RENDITION_LABEL_REF,
  type PublishedRendition,
  type SignedFetch,
} from "./image-processing/publish-renditions";
export {
  shouldAttemptDerivation,
  recordAttempt,
  backoffMs,
  fallbackIsDue,
  DERIVATION_FALLBACK_HOURS,
  type AttemptOutcome,
  type DerivationAttempt,
} from "./image-processing/derivation-attempts";
export {
  findDuplicate,
  captureFingerprint,
  PERCEPTUAL_DISTANCE_THRESHOLD,
  type DuplicateTier,
  type DuplicateFinding,
  type ImportCandidate,
  type LibraryEntry,
} from "./import/duplicate-tiers";
export { openImportStore, importDir, type ImportStore } from "./import/import-store";
export {
  runImport,
  walkImportable,
  type ImportDeps,
  type ImportProgress,
} from "./import/run-import";
export {
  shouldAttempt,
  summarize,
  isComplete,
  DEFAULT_PACING,
  DEFAULT_IMPORT_DELAY_MS,
  type ImportItem,
  type ImportItemStatus,
  type ImportRunSummary,
  type ImportPacing,
} from "./import/import-run";
export {
  variantSrc,
  tileTargetLongEdge,
  viewportTargetLongEdge,
  type DisplaySource,
} from "./variant-src";

// Video (items 26/27)
export {
  parseProbeOutput,
  parseFrameRate,
  normalizeRotation,
  displayLongEdge,
  type VideoFacts,
} from "./video/probe";
export {
  createFfmpegTools,
  posterTimestamp,
  scaleFilter,
  transposeFilter,
  UnsupportedVideoError,
  POSTER_MAX_OFFSET_SECONDS,
  type VideoTools,
  type PosterOptions,
  type TranscodeOptions,
  type SkimOptions,
  type FfmpegToolsOptions,
} from "./video/video-tools";
export {
  deriveVideoLadder,
  videoSourceOf,
  missingVideoClasses,
  videoLadderIsComplete,
  type DerivedVideoRendition,
  type VideoDerivationFailure,
  type VideoLadderResult,
} from "./video/derive-video-ladder";

// EXIF reader
export { extractExif } from "./metadata/exif-reader";
export type { ExifFields } from "./metadata/exif-generator";
