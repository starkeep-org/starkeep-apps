import type { VerifyResult } from "@starkeep/sync-engine";

/**
 * Phrase an integrity check for a person.
 *
 * Kept out of the screen component so it can be tested without a renderer —
 * this is the sentence someone decides whether to wipe their phone on, and it
 * is worth pinning directly rather than through a UI harness.
 *
 * Says "rows", not "photos": the count includes tombstones and labels, because
 * it is a comparison of two nodes' stored state rather than a library count.
 * Rounding it into "photos" would be a friendlier sentence and a false one.
 *
 * Reports **both directions**, because they are different problems with
 * different consequences. The cloud missing rows is a backup that is not
 * complete; *this phone* missing rows is a device that would restore wrong.
 * The check that finds the first is deliberately one-directional — a bucket
 * where the cloud has more is ordinary data not pulled yet, not corruption — so
 * reusing it for the second would show a clean result to a phone that has
 * itself lost data, which is the case where being wrong costs the most.
 */
export function describeVerify(result: VerifyResult | null): string {
  if (!result) return "No cloud is configured, so there is nothing to check against.";
  if (!result.supported) {
    // A peer that cannot answer is not a peer that agrees.
    return "This cloud could not answer an integrity check, so nothing was verified.";
  }
  const problems: string[] = [];
  if (result.divergentBuckets > 0) {
    problems.push(
      `The cloud is missing rows in ${result.divergentBuckets} time range${
        result.divergentBuckets === 1 ? "" : "s"
      }`,
    );
  }
  if (result.missingLocally > 0) {
    problems.push(
      `this phone is missing rows in ${result.missingLocally} time range${
        result.missingLocally === 1 ? "" : "s"
      }`,
    );
  }
  if (problems.length > 0) {
    return `${problems.join(", and ")}. The next sync will fill the gaps.`;
  }
  return `${result.peerRows} of ${result.localRows} rows are in the cloud.`;
}

/**
 * Whether a check found anything wrong, in either direction.
 *
 * "Could not verify" counts as a problem. A check that did not happen is not a
 * check that passed, and styling it the same as agreement is how an
 * unanswerable check reads as a clean bill of health.
 */
export function verifyFoundProblem(result: VerifyResult | null): boolean {
  if (!result) return false;
  return !result.supported || result.divergentBuckets > 0 || result.missingLocally > 0;
}
