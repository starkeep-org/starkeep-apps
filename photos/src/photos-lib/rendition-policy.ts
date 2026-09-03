/**
 * The browser-facing selection boundaries, and the snap onto them — re-exported
 * from the package every Photos surface shares.
 *
 * The definitions moved out to `@starkeep/photos-ladder` for the reason
 * `ladder.ts` beside this file already gives: `photos-mobile` cannot reach
 * anything under `photos/`, so a phone that measured its own surfaces would
 * have meant a second copy of `canonicalTarget`. A snap rule that disagreed
 * with the web app's would put one device class on a different rung for the
 * same photograph at the same size — a difference nothing would report, because
 * both answers are a valid rung.
 *
 * This file stays as the name every call site in this app already imports, so
 * the extraction is invisible from here.
 */

export {
  currentRenditionPolicies,
  canonicalTarget,
  type MediaPolicyKind,
  type RenditionPolicies,
  type RenditionThresholdPolicy,
} from "@starkeep/photos-ladder";
