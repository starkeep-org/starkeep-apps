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
  SKIM_SEGMENT_SECONDS,
  SKIM_INTERVAL_SECONDS,
  applicableStillClasses,
  applicableVideoClasses,
  renditionLongEdge,
  topApplicableStillClass,
  classForTargetLongEdge,
  CHEAP_STILL_CLASSES,
  CHEAP_TARGET_LONG_EDGE,
  transcodeWouldChangeAnything,
  skimDurationSeconds,
  type SizeClass,
  type StillClassSpec,
  type VideoClassSpec,
  type VideoSource,
} from "./ladder";
export {
  deriveStillLadder,
  deriveStillLadderStream,
  decodeForDerivation,
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
  type DecodedImage,
} from "./image-processing/derive-ladder";
export {
  deriveAndPublish,
  type DeriveAndPublishParams,
  type DeriveAndPublishResult,
  type DerivationAttemptStore,
} from "./image-processing/derive-and-publish";
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
  isVideoPath,
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
  stillDisplay,
  posterSrc,
  playbackSrc,
  isVideoRecord,
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
  publishVideoFacts,
  publishVideoRendition,
} from "./video/publish-video";
export {
  deriveAndPublishVideo,
  isTerminalVideoError,
  type VideoIngestResult,
  type VideoIngestDeps,
} from "./video/derive-and-publish";
export {
  deriveVideoLadder,
  videoSourceOf,
  missingVideoClasses,
  videoLadderIsComplete,
  type DerivedVideoRendition,
  type VideoDerivationFailure,
  type VideoLadderResult,
} from "./video/derive-video-ladder";

// Decoding (items 30/32)
export {
  UndecodableError,
  isNoDecoderError,
  classifyDecodeError,
} from "./image-processing/decode-errors";
export {
  createSipsDecoder,
  needsPlatformDecoder,
  NO_PLATFORM_DECODER,
  NEEDS_PLATFORM_DECODER,
  type PlatformDecoder,
} from "./image-processing/platform-decoder";
export {
  findEmbeddedPreviews,
  extractLargestPreview,
  isRawType,
  RAW_TYPES,
  type EmbeddedPreview,
} from "./image-processing/dng-preview";
export {
  decodeSource,
  canDecodeHere,
  type DecodedSource,
  type DecodeSourceOptions,
} from "./image-processing/decode-source";

// Live Photo pairing (item 31)
export {
  findLivePhotoPairs,
  pairConfidence,
  toCandidate,
  isStillCandidate,
  isMotionCandidate,
  MAX_MOTION_DURATION_MS,
  type PairCandidate,
  type LivePhotoPair,
  type PairConfidence,
} from "./import/live-photo";

// EXIF reader
export { extractExif } from "./metadata/exif-reader";
export type { ExifFields } from "./metadata/exif-generator";
