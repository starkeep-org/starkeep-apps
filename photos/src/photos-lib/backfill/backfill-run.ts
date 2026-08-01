/**
 * Backfilling the ladder for a library that predates it (item 8).
 *
 * ## Why this is separate from the import loop
 *
 * The import loop turns *files* into records. This turns *records that already
 * exist* into records with a complete ladder. They share a shape — resumable,
 * rate-limited, per-item outcomes — and almost nothing else: backfill never
 * creates a record, never dedups, and its work unit is a record id rather than
 * a path.
 *
 * ## Why it reads from local object storage
 *
 * The rule the whole plan is built on: **never transfer an original in order to
 * derive from it**. On the laptop the originals are already there — often as
 * symlinks into watched folders, with no byte duplication — so backfill reads
 * them locally, derives, and pushes only the renditions up. A backfill that
 * pulled originals from the cloud would cost egress *and*, once archiving
 * starts, a 48-hour thaw per photo, to produce files that could have been made
 * for free.
 *
 * ## Ordering: oldest first
 *
 * Deliberately not newest-first, and not arbitrary. Archiving can only begin on
 * a record once its ladder is complete, and the oldest material is both the
 * least likely to be viewed and the largest share of the library — so working
 * upward from the oldest starts the savings soonest and leaves the recent
 * photos, which are the ones actually being looked at, on their existing path
 * until last.
 */

import type { SizeClass } from "../ladder";

/** Where one record got to. Terminal states are never revisited. */
export type BackfillItemStatus =
  | "pending"
  /** Every applicable rung now exists. Terminal. */
  | "complete"
  /** Some rungs were produced; the rest failed. Retried. */
  | "partial"
  /** Failed in a way that might not recur. Retried. */
  | "failed"
  /** This node cannot decode the original. Terminal here — see the note below. */
  | "undecodable"
  /**
   * The original is not readable from this node at all: evicted locally and
   * archived in the cloud. Terminal for *this* run and not an error — the
   * record is simply not backfillable without a thaw somebody has to pay for.
   */
  | "unavailable";

export interface BackfillItem {
  readonly recordId: string;
  readonly status: BackfillItemStatus;
  /** Rungs that exist now, so a partial retry only does what is missing. */
  readonly producedClasses: readonly SizeClass[];
  readonly detail: string | null;
  readonly attempts: number;
  readonly updatedAtMs: number;
}

export interface BackfillSummary {
  readonly total: number;
  readonly complete: number;
  readonly partial: number;
  readonly failed: number;
  readonly undecodable: number;
  readonly unavailable: number;
  readonly pending: number;
}

/**
 * How many times a record is retried before it is left alone.
 *
 * Bounded because "retryable" and "retry forever" are not the same thing. A
 * record that has failed transiently five times is not going to succeed on the
 * sixth in the same run, and continuing to try it costs the throughput of every
 * record behind it in the queue.
 */
export const MAX_BACKFILL_ATTEMPTS = 5;

export function shouldAttemptBackfill(previous: BackfillItem | null): boolean {
  if (!previous) return true;
  if (previous.status === "complete") return false;
  // Terminal on this node, and re-deciding it needs a different node or a
  // different build — not another pass of the same one.
  if (previous.status === "undecodable" || previous.status === "unavailable") return false;
  return previous.attempts < MAX_BACKFILL_ATTEMPTS;
}

export function summarizeBackfill(items: readonly BackfillItem[]): BackfillSummary {
  const s = {
    total: items.length,
    complete: 0, partial: 0, failed: 0,
    undecodable: 0, unavailable: 0, pending: 0,
  };
  for (const item of items) {
    if (item.status === "complete") s.complete += 1;
    else if (item.status === "partial") s.partial += 1;
    else if (item.status === "failed") s.failed += 1;
    else if (item.status === "undecodable") s.undecodable += 1;
    else if (item.status === "unavailable") s.unavailable += 1;
    else s.pending += 1;
  }
  return s;
}

/**
 * Whether the run has anything left worth attempting.
 *
 * Not "everything is complete". A library will always contain records this node
 * cannot decode and originals it cannot reach, and reporting the run as
 * unfinished because of them would leave an operator watching a progress bar
 * that never fills.
 */
export function backfillIsComplete(summary: BackfillSummary): boolean {
  return summary.pending === 0 && summary.failed === 0 && summary.partial === 0;
}

/**
 * Pacing, which matters more here than for import.
 *
 * Backfill is pure derivation — the most CPU-hungry thing this app does, run
 * across the entire library at once, on a machine somebody is using. The
 * default is deliberately unhurried: a backfill that finishes in six hours
 * overnight is strictly better than one that finishes in two and makes the
 * laptop unusable for those two, because nobody is waiting on it.
 */
export interface BackfillPacing {
  readonly delayMs: number;
  /** Stop after this many records in one run. `null` for no limit. */
  readonly maxItemsPerRun: number | null;
}

export const DEFAULT_BACKFILL_PACING: BackfillPacing = {
  delayMs: 250,
  maxItemsPerRun: null,
};
