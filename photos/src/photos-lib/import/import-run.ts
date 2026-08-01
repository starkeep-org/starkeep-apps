/**
 * Resumable, per-item, content-hash-keyed folder import.
 *
 * ## Why an import needs its own tracking table
 *
 * A folder import is the longest-running thing this app does: tens of thousands
 * of files, hours of wall clock, across a laptop that will sleep. It *will* be
 * interrupted, and the interesting question is what happens next time.
 *
 * Without per-item tracking the only resumable unit is the whole run, so an
 * interruption at 90% costs 90% of the work — or worse, the operator restarts
 * it and the library gains ten thousand duplicates. Record-level dedup means
 * the second outcome no longer corrupts anything, but it still means re-reading
 * and re-hashing every file to discover that.
 *
 * ## Keyed by content hash, not by path
 *
 * Paths move. A resumed import must recognise a file it already imported even
 * if the operator reorganised the folder between runs, and must *not* re-import
 * a file that was merely renamed. The hash is what survives both.
 *
 * The cost is that hashing happens before the item is known to be new — which
 * is unavoidable, since the hash is the identity. Reading a file to hash it is
 * cheap next to decoding and deriving from it, so the ordering is right.
 */

/** Where an item got to. Terminal states are never revisited on resume. */
export type ImportItemStatus =
  /** Hashed and recorded, not yet processed. */
  | "pending"
  /** Registered as a record (or matched an existing one). Terminal. */
  | "imported"
  /** A duplicate that was deliberately not imported. Terminal. */
  | "skipped"
  /**
   * Failed in a way that might not recur — a transient network error, a
   * temporarily locked file. Retried on the next run.
   */
  | "failed"
  /**
   * Cannot be imported by this build: an unreadable format, a corrupt file.
   * Terminal, so a resume does not spend the whole run re-failing on the same
   * hundred files it failed on last time.
   */
  | "unsupported";

export interface ImportItem {
  readonly contentHash: string;
  /** Where it was last seen. Informational — the hash is the identity. */
  readonly sourcePath: string;
  readonly sizeBytes: number;
  readonly status: ImportItemStatus;
  /** Record it became, or matched. Null for anything not imported. */
  readonly recordId: string | null;
  /** For `skipped`: which tier matched, so a report can explain itself. */
  readonly duplicateTier: string | null;
  readonly detail: string | null;
  readonly updatedAtMs: number;
}

export interface ImportRunSummary {
  readonly total: number;
  readonly imported: number;
  readonly skipped: number;
  readonly failed: number;
  readonly unsupported: number;
  readonly pending: number;
}

/**
 * Whether a previously-seen item should be attempted again.
 *
 * The distinction that makes a resume useful rather than merely restartable:
 * `failed` is worth retrying and `unsupported` is not. Conflating them means
 * either abandoning files that would succeed on a second attempt, or spending
 * every subsequent run re-failing on the same unreadable ones — and on a large
 * import the second is indistinguishable from the tool being broken.
 */
export function shouldAttempt(previous: ImportItem | null): boolean {
  if (!previous) return true;
  return previous.status === "pending" || previous.status === "failed";
}

export function summarize(items: readonly ImportItem[]): ImportRunSummary {
  const summary = {
    total: items.length,
    imported: 0,
    skipped: 0,
    failed: 0,
    unsupported: 0,
    pending: 0,
  };
  for (const item of items) {
    if (item.status === "imported") summary.imported += 1;
    else if (item.status === "skipped") summary.skipped += 1;
    else if (item.status === "failed") summary.failed += 1;
    else if (item.status === "unsupported") summary.unsupported += 1;
    else summary.pending += 1;
  }
  return summary;
}

/**
 * Whether the run has anything left to do.
 *
 * Deliberately not "every item is imported": a run whose remaining items are
 * all terminal-but-not-imported is *finished*, and reporting it as incomplete
 * would leave an operator waiting for progress that will never come.
 */
export function isComplete(summary: ImportRunSummary): boolean {
  return summary.pending === 0 && summary.failed === 0;
}

/**
 * The rate limiter's shape: how long to wait before starting the next item.
 *
 * An import competes with everything else on the machine — including the
 * derivation it triggers, which is the expensive half. Running flat out makes
 * the laptop unusable and, on a phone, gets the process killed. A fixed small
 * delay is enough to keep the machine responsive and is far easier to reason
 * about than a feedback loop.
 */
export const DEFAULT_IMPORT_DELAY_MS = 50;

export interface ImportPacing {
  readonly delayMs: number;
  /** Stop after this many items in one run. `null` for no limit. */
  readonly maxItemsPerRun: number | null;
}

export const DEFAULT_PACING: ImportPacing = {
  delayMs: DEFAULT_IMPORT_DELAY_MS,
  maxItemsPerRun: null,
};
