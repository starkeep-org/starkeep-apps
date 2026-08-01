/**
 * What happened last time we tried to derive a record's ladder, and whether it
 * is worth trying again.
 *
 * ## Why this exists when derivation state is a query
 *
 * Which rungs are *missing* is a query over child records — there is no
 * `needs-derivation` flag, deliberately, because a shared mutable "somebody
 * should fix this" invites two nodes to derive the same record and produce two
 * children.
 *
 * But "which rungs are missing" cannot distinguish a record nobody has tried
 * yet from one that has failed the same way every day for a month. Without that
 * distinction the cloud sweeper re-downloads and re-fails on every HEIC in the
 * library, daily, forever — the plan calls this out specifically, because the
 * cloud fallback covers JPEG, PNG, WebP and AVIF only and a phone-captured
 * library is mostly HEIC.
 *
 * So this records *attempts*, not state. It is advisory: losing it costs a
 * wasted retry, never a missing rendition.
 *
 * ## Node-local, and not syncable
 *
 * An attempt is a fact about one node's capabilities — "this node has no HEIC
 * decoder" — and syncing it would let a phone's failure tell the laptop not to
 * bother, when the laptop can decode it fine. That is the exact inversion of
 * what the fallback is for.
 */

/** Why an attempt stopped, and therefore whether repeating it could help. */
export type AttemptOutcome =
  /** Every applicable rung was produced. */
  | "complete"
  /**
   * This node cannot decode this format at all. **Permanent for this node** —
   * retrying accomplishes nothing until the node itself changes, and this is
   * the outcome that keeps the sweeper off the HEIC library.
   */
  | "undecodable-here"
  /**
   * Something transient: out of memory, thermal throttling, a killed process, a
   * network read that failed. Worth retrying with backoff.
   */
  | "transient-failure"
  /**
   * The bytes are not here. Not a failure of derivation — the record is elided
   * or the original was never uploaded — and not something backoff helps with,
   * since the fix is a transfer rather than another attempt.
   */
  | "source-unavailable";

export interface DerivationAttempt {
  readonly recordId: string;
  readonly outcome: AttemptOutcome;
  /** Epoch ms. */
  readonly attemptedAtMs: number;
  /** Consecutive transient failures, for backoff. Reset by any other outcome. */
  readonly consecutiveFailures: number;
  /** Free text for the residency inspector; never parsed. */
  readonly detail?: string;
}

/**
 * Exponential backoff for transient failures, capped.
 *
 * The cap matters more than the curve: an unbounded backoff eventually means
 * "never", and a record that failed six times for six unrelated transient
 * reasons is not a record that should be abandoned. A day is long enough that
 * a broken node isn't hammering, and short enough that a fixed node recovers
 * without intervention.
 */
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

export function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1));
}

/**
 * Should this node try (again) to derive this record?
 *
 * `null` for a record never attempted — try it.
 */
export function shouldAttemptDerivation(
  attempt: DerivationAttempt | null,
  nowMs: number,
): { attempt: boolean; reason: string } {
  if (!attempt) return { attempt: true, reason: "never attempted" };

  switch (attempt.outcome) {
    case "complete":
      // The ladder query is the authority on whether work remains. If it says
      // rungs are missing despite a `complete` attempt, something changed —
      // a respec, a reaped child — and this must not stand in the way.
      return { attempt: true, reason: "previously complete but rungs are missing again" };

    case "undecodable-here":
      // The one permanent outcome. Nothing about waiting makes a missing codec
      // appear, and this is what keeps a daily sweeper off an entire HEIC
      // library. Clearing the record is how a node that gains a decoder retries.
      return { attempt: false, reason: "this node cannot decode this format" };

    case "source-unavailable":
      // Backoff would be the wrong tool: the fix is a transfer, not another
      // attempt. Whatever brings the bytes here will clear this.
      return { attempt: false, reason: "the source bytes are not on this node" };

    case "transient-failure": {
      const wait = backoffMs(attempt.consecutiveFailures);
      const ready = attempt.attemptedAtMs + wait;
      return nowMs >= ready
        ? { attempt: true, reason: "backoff elapsed" }
        : {
            attempt: false,
            reason: `backing off for ${Math.ceil((ready - nowMs) / 1000)}s after ${attempt.consecutiveFailures} failure(s)`,
          };
    }
  }
}

/** Fold an outcome into the stored attempt. */
export function recordAttempt(
  previous: DerivationAttempt | null,
  recordId: string,
  outcome: AttemptOutcome,
  nowMs: number,
  detail?: string,
): DerivationAttempt {
  return {
    recordId,
    outcome,
    attemptedAtMs: nowMs,
    // Only transient failures accumulate. Any other outcome resets the count,
    // so a record that fails twice, succeeds, then fails again starts its
    // backoff from the beginning rather than from an hour.
    consecutiveFailures:
      outcome === "transient-failure"
        ? (previous?.outcome === "transient-failure" ? previous.consecutiveFailures : 0) + 1
        : 0,
    ...(detail ? { detail } : {}),
  };
}

/**
 * How long after ingest the cloud takes over derivation for a record the
 * originating node never completed.
 *
 * The originating node owns derivation **indefinitely** — it retries from its
 * own queue whenever it can. This is not a handover to a competitor but a
 * fallback for the case where that node is gone, wiped, or permanently unable.
 * A day is long enough that an ordinary phone gets its chance (overnight, on
 * wifi, on a charger) and short enough that a lost phone doesn't leave a record
 * un-derivable forever.
 *
 * The fallback is a **singleton** — one actor, the cloud — which is why there
 * is no contention to resolve and no lease to hold.
 */
export const DERIVATION_FALLBACK_HOURS = 24;

export function fallbackIsDue(
  recordCreatedAtMs: number,
  nowMs: number,
  fallbackHours = DERIVATION_FALLBACK_HOURS,
): boolean {
  return nowMs - recordCreatedAtMs >= fallbackHours * 60 * 60 * 1000;
}
