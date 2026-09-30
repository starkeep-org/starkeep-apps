/**
 * What one original asks of the still ladder, answered on the phone.
 *
 * A data server hands Photos a summary per original; the phone is its own data
 * plane and has the rows instead. So it answers the same question from the
 * same rules the servers summarise by — the threshold stamped on the original,
 * the standard sizes below it, and whether the live canonical stand-in was
 * made for it — and the ladder reads one shape either way.
 */

import {
  expectedCanonicalFidelity,
  standardSizesOf,
  topFidelity,
  type DataRecord,
  type StandInStandards,
} from "@starkeep/protocol-primitives";
import type { StandInTarget } from "@starkeep/photos-ladder";

/**
 * The original's target, or null when nobody has measured the original: with
 * no fidelity there is no answer yet, and the ladder falls back to the
 * platform's default threshold.
 */
export function standInTargetFor(
  original: DataRecord,
  standIns: readonly DataRecord[],
  standards: StandInStandards,
): StandInTarget | null {
  if (original.fidelity === null) return null;
  const canonical =
    standIns.find((s) => !s.deletedAt && s.standInRole === "canonical" && s.fidelity !== null) ?? null;
  const expected = expectedCanonicalFidelity(original, standards);
  const top = topFidelity(original, canonical, standards);
  return {
    canonical: expected,
    smallerSizes: standardSizesOf(original, standards).filter((size) => top === null || size < top),
    canonicalOutdated: canonical !== null && expected !== null && canonical.fidelity !== expected,
    currentCanonical: canonical?.fidelity ?? null,
  };
}
