/**
 * The backfill driver (item 8).
 *
 * **Blocked on item 9b by design.** The ladder's class maxima are provisional
 * until the visual test replaces them with measured numbers, and backfill is
 * the one job that applies them to the entire library at once. Running it
 * against provisional numbers would derive tens of thousands of renditions at
 * sizes that are about to change — and then, because the archive gate fires on
 * a complete ladder, start freezing originals behind a 48-hour thaw on the
 * strength of them. Built now, run later; {@link assertLadderMeasured} is the
 * interlock rather than a note in a document.
 */

import type { SizeClass } from "../ladder";
import {
  DEFAULT_BACKFILL_PACING,
  MAX_BACKFILL_ATTEMPTS,
  shouldAttemptBackfill,
  type BackfillItem,
  type BackfillItemStatus,
  type BackfillPacing,
} from "./backfill-run";

/** One record the backfill might have work to do on, oldest first. */
export interface BackfillCandidate {
  readonly recordId: string;
  readonly type: string;
  readonly originalFilename: string | null;
  /** Which rungs already exist, so only the missing ones are derived. */
  readonly existingClasses: readonly SizeClass[];
}

export interface BackfillStore {
  get(recordId: string): BackfillItem | null;
  put(item: BackfillItem): void;
  all(): BackfillItem[];
}

export interface BackfillDeps {
  /**
   * Records to consider, **oldest first**, in pages.
   *
   * Paged rather than returned whole: a 60k-item library's worth of candidates
   * is a list nobody needs resident, and the run can be interrupted between
   * pages without having paid for the rest.
   */
  readonly listCandidates: (cursor: string | null) => Promise<{
    candidates: BackfillCandidate[];
    nextCursor: string | null;
  }>;
  /**
   * Read the original's bytes **from local storage**.
   *
   * `null` means it is not here — evicted locally, and archived or simply
   * absent in the cloud. That is `unavailable`, not a failure: deriving it
   * would require a transfer, which is the one thing this job must not do.
   */
  readonly readLocalOriginal: (recordId: string) => Promise<Uint8Array | null>;
  /** Derive and publish the missing rungs; returns what now exists. */
  readonly deriveMissing: (
    candidate: BackfillCandidate,
    bytes: Uint8Array,
  ) => Promise<{ produced: SizeClass[]; missing: SizeClass[] }>;
  /** Called when a record's ladder is complete, so the archive gate can fire. */
  readonly onComplete?: (recordId: string) => Promise<void>;
  /** Classify a derivation failure as "never here" rather than "not now". */
  readonly isUndecodable: (err: unknown) => boolean;
}

export interface BackfillProgress {
  readonly processed: number;
  readonly completed: number;
  readonly stoppedEarly: boolean;
}

/**
 * The interlock for item 9b.
 *
 * Backfill applies the ladder to the whole library in one pass, and the archive
 * gate turns a complete ladder into a frozen original. Doing that on
 * provisional numbers is not "a bit wasteful" — it is unrecoverable without
 * paying to thaw everything it froze. So the caller has to state that the
 * numbers are measured, and the default is that they are not.
 */
export function assertLadderMeasured(ladderMeasured: boolean): void {
  if (!ladderMeasured) {
    throw new Error(
      "Backfill is gated on item 9b: the ladder's class maxima are still provisional. " +
        "Running now would derive the whole library at sizes that are about to change, and " +
        "the archive gate would begin freezing originals on the strength of them. " +
        "Run the visual test, replace the numbers, then pass ladderMeasured: true.",
    );
  }
}

export async function runBackfill(
  store: BackfillStore,
  deps: BackfillDeps,
  options: { ladderMeasured: boolean; pacing?: BackfillPacing },
): Promise<BackfillProgress> {
  assertLadderMeasured(options.ladderMeasured);
  const pacing = options.pacing ?? DEFAULT_BACKFILL_PACING;

  let processed = 0;
  let completed = 0;
  let stoppedEarly = false;
  let cursor: string | null = null;

  do {
    const page = await deps.listCandidates(cursor);
    cursor = page.nextCursor;

    for (const candidate of page.candidates) {
      if (pacing.maxItemsPerRun !== null && processed >= pacing.maxItemsPerRun) {
        stoppedEarly = true;
        break;
      }

      const previous = store.get(candidate.recordId);
      if (!shouldAttemptBackfill(previous)) continue;
      const attempts = (previous?.attempts ?? 0) + 1;

      try {
        const bytes = await deps.readLocalOriginal(candidate.recordId);
        if (!bytes) {
          // Not an error. Deriving this would require pulling the original
          // back, which is the one rule the plan does not bend.
          store.put(
            item(candidate.recordId, "unavailable", [], attempts, "original not resident locally"),
          );
          processed += 1;
          continue;
        }

        const { produced, missing } = await deps.deriveMissing(candidate, bytes);
        const all = [...candidate.existingClasses, ...produced];
        const status: BackfillItemStatus = missing.length === 0 ? "complete" : "partial";
        store.put(
          item(
            candidate.recordId,
            status,
            all,
            attempts,
            missing.length === 0 ? null : `still missing: ${missing.join(", ")}`,
          ),
        );
        if (status === "complete") {
          completed += 1;
          // Only now — the gate turns a complete ladder into a frozen original,
          // and asserting completeness while a rung is missing is how a record
          // ends up behind a thaw with nothing readable in front of it.
          await deps.onComplete?.(candidate.recordId);
        }
      } catch (err) {
        const terminal = deps.isUndecodable(err);
        store.put(
          item(
            candidate.recordId,
            terminal ? "undecodable" : "failed",
            previous?.producedClasses ?? [],
            attempts,
            (err as Error).message,
          ),
        );
      }

      processed += 1;
      await pause(pacing.delayMs);
    }
  } while (cursor !== null && !stoppedEarly);

  return { processed, completed, stoppedEarly };
}

function item(
  recordId: string,
  status: BackfillItemStatus,
  producedClasses: readonly SizeClass[],
  attempts: number,
  detail: string | null,
): BackfillItem {
  return {
    recordId,
    status,
    // Deduplicated: a partial retry adds to what was already there, and a class
    // counted twice would make "how far along is this" wrong in the report.
    producedClasses: [...new Set(producedClasses)],
    detail,
    attempts,
    updatedAtMs: Date.now(),
  };
}

function pause(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export { MAX_BACKFILL_ATTEMPTS };
