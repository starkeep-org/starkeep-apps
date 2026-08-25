/**
 * Photos' rendition ladder — re-exported from the package every Photos surface
 * shares.
 *
 * The definitions moved out to `@starkeep/photos-ladder` because `photos-mobile`
 * could not reach them here: it depends on the four `@starkeep/*` platform
 * packages and on nothing from `photos`, so implementing the phone against this
 * file would have meant a second copy of `STILL_LADDER`. Two implementations of
 * the resolution rule that disagree is a rendering bug visible on one device
 * class only.
 *
 * This file stays as the name every call site in this app already imports, so
 * the extraction is invisible from here.
 */

export {
  STILL_LADDER,
  VIDEO_LADDER,
  DEFAULT_DISABLED_CLASSES,
  applicableStillClasses,
  applicableVideoClasses,
  classForTargetLongEdge,
  renditionLongEdge,
  topApplicableStillClass,
  isOwnTopOfLadder,
  transcodeWouldChangeAnything,
  skimDurationSeconds,
  SKIM_SEGMENT_SECONDS,
  SKIM_INTERVAL_SECONDS,
  CHEAP_STILL_CLASSES,
  CHEAP_TARGET_LONG_EDGE,
  type SizeClass,
  type StillClassSpec,
  type VideoClassSpec,
  type VideoSource,
} from "@starkeep/photos-ladder";
