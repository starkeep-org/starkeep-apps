/**
 * What one original asks of the still ladder, answered on the phone.
 *
 * A data server hands Photos a summary per original; the phone is its own data
 * plane and has the rows instead. So it answers the same question from the
 * same rules the servers summarise by — the threshold stamped on the original
 * and the standard sizes below it — and the ladder reads one shape either way.
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
 * The original's target, or null when no rule here can place the original yet:
 * nobody has measured it, or no node has stamped it with a canonical
 * threshold. The ladder derives nothing for such an original, and the cloud
 * stamps an unstamped one on the next exchange.
 */
export function standInTargetFor(
  original: DataRecord,
  standIns: readonly DataRecord[],
  standards: StandInStandards,
): StandInTarget | null {
  if (original.fidelity === null || original.canonicalThreshold === null) return null;
  const canonical =
    standIns.find((s) => !s.deletedAt && s.standInRole === "canonical" && s.fidelity !== null) ?? null;
  const top = topFidelity(original, canonical, standards);
  return {
    canonical: expectedCanonicalFidelity(original, standards),
    smallerSizes: standardSizesOf(original, standards).filter((size) => top === null || size < top),
  };
}
