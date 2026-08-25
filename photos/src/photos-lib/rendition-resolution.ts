/**
 * The ideal-and-fallback rule — re-exported from the shared ladder package.
 *
 * It lives beside the ladder because it *is* the ladder's rule, and mobile
 * needs the same one: a phone resolving differently from the web is a rendering
 * bug that only appears on one device class. See `@starkeep/photos-ladder` for
 * the rule itself and the cases it is written against.
 */

export {
  resolveRendition,
  resolveRenditions,
  resolveWithoutDimensions,
  type DerivedChild,
  type RenditionChoice,
  type RenditionEntry,
  type RenditionState,
  type ResolveOptions,
} from "@starkeep/photos-ladder";
