/**
 * One window of work, chosen by the job graph (item 14).
 *
 * ## Why a tick rather than a sync
 *
 * The OS grants a window and takes it back. What should happen inside one is
 * already written down — `JOB_GRAPH` names the jobs, their conditions and their
 * preferred order — and until now nothing consumed it but a debug label. This
 * is the consumer: read the device, ask the graph what may run, and run it
 * until the window closes.
 *
 * Scheduling a bare `sync()` instead would have been shorter and would have
 * thrown away the part that matters. A sync uploads originals, and uploading
 * originals over cellular is the one thing on this device that costs a person
 * money. The graph says so; something has to read it.
 *
 * ## Why the deadline is a getter rather than a timer
 *
 * `SyncOptions.signal` is structurally `{ readonly aborted: boolean }` and is
 * read once per round, so a deadline needs nothing running to enforce it. No
 * timer to clear, nothing to leak into a headless context that is about to be
 * frozen, and the same object works for every job that takes one.
 *
 * ## What a job may assume
 *
 * That it will be abandoned. Every binding below is bounded and resumable, and
 * the ones that are neither are absent rather than accommodated — see
 * {@link UNBOUND_JOBS}.
 */

import type { MobileNode } from "../node";
import { canRun, jobSpec, preferredOrder, type DeviceState, type JobId } from "./job-graph";

/** What one job did, or why it did nothing. */
export interface JobOutcome {
  readonly job: JobId;
  readonly ran: boolean;
  /** What happened, or the condition that ruled the job out. */
  readonly detail: string;
  readonly ms: number;
}

export interface TickReport {
  readonly startedAt: string;
  /** Null when the window ended before the device could be read. */
  readonly device: DeviceState | null;
  readonly outcomes: readonly JobOutcome[];
  /** True when the deadline closed the window before every job was considered. */
  readonly ranOutOfTime: boolean;
  readonly totalMs: number;
  /**
   * Set when something outside the tick gave up on it, naming what it was
   * doing.
   *
   * A window that hangs writes no report of its own, and a report that never
   * arrives is indistinguishable from a process that never woke — which is the
   * ambiguity that cost three sessions of diagnosis. The watchdog in
   * `background-task.ts` writes the last progress snapshot with this set.
   */
  readonly abandoned?: string;
}

/**
 * Jobs the graph declares and this device cannot yet perform.
 *
 * Named here rather than silently skipped, so the report says which of the
 * graph's eight jobs are actually wired.
 *
 * One job left this list when the phone gained an encoder.
 * `derive-ladder-full` stays: the rungs above `image-medium` are 2560 and 4272
 * pixels on a side, which is real CPU for pixels no phone screen can show, and
 * they remain the work of a node running `sharp`. See
 * `MOBILE_DERIVE_CEILING_LONG_EDGE`.
 *
 * `derive-ladder-cheap` is bound but still conditional — a build without the
 * native encoder module reports so through {@link TickDeps.deriveRenditions}
 * rather than by appearing here, because that is a property of the binary rather
 * than of the graph.
 */
export const UNBOUND_JOBS: readonly JobId[] = ["derive-ladder-full"];

export interface TickDeps {
  readonly node: MobileNode;
  readonly device: DeviceState;
  /**
   * Bring in whatever the camera has taken since the last look.
   *
   * Takes a signal because the pass is otherwise unbounded: it considers a
   * fixed number of the newest assets, and hashing an unimported one costs
   * real time. A first tick against a camera roll nobody has imported would
   * run past the window and be killed rather than stopped, losing the report
   * of everything it did.
   */
  readonly importRecent: (signal: {
    readonly aborted: boolean;
  }) => Promise<{
    imported: number;
    skipped: number;
    failed: number;
    /** This pass only established the import watermark. See `media/import-cursor.ts`. */
    cursorSeeded?: boolean;
  }>;
  /**
   * Make the rungs this device's own photographs are missing.
   *
   * Takes a signal for the reason `importRecent` does, and more sharply: one
   * record costs a decode and up to three AVIF encodes, and the pass is
   * deliberately allowed to walk more than one page inside a window. Without a
   * signal it would run to the end of the alias table or to the moment the OS
   * killed the process, which loses the report of everything the window did.
   *
   * Resolves null on a device that cannot derive at all — no camera roll, or a
   * build with no encoder in it. Absent entirely on a caller that has no
   * derivation to offer, which is how the tick's own tests are written.
   */
  readonly deriveRenditions?: (signal: {
    readonly aborted: boolean;
  }) => Promise<{
    /** Records this pass paid a decode for. */
    scanned: number;
    /** Rungs written. */
    written: number;
    failed: number;
    /** Every original this device holds has now been looked at. */
    complete: boolean;
  } | null>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /**
   * The report the tick would produce if it stopped right now.
   *
   * Called on entry, before each job and after each job, so a watchdog outside
   * the tick has something to write when a job never returns. The in-flight job
   * appears in the snapshot as an outcome that has not run, carrying the reason
   * it would have if the window ended there.
   */
  readonly onProgress?: (snapshot: TickReport) => void;
}

export interface TickOptions {
  /** Wall-clock time after which no further job may start. */
  readonly deadlineMs: number;
}

/**
 * How much of a window one sync may take.
 *
 * Sync is the only unbounded job here — a first library upload is hundreds of
 * rounds — so without a share of its own it would consume every window and the
 * jobs after it would never run. Eviction in particular has to keep running on
 * a phone whose budget is full, and eviction sits behind sync in the order.
 */
export const SYNC_DEADLINE_SHARE = 0.8;

/**
 * How much of a window import may take.
 *
 * Smaller than sync's share, and ahead of it in the order, which is the right
 * way round: noticing a photograph is what makes it *possible* to send, and
 * sending is what actually gets it off the device. A first tick on an
 * un-imported camera roll would otherwise spend the whole window hashing and
 * upload nothing at all.
 */
export const IMPORT_DEADLINE_SHARE = 0.25;

/**
 * How much of a window derivation may take.
 *
 * Half of what is left when it starts, which on an ordinary window is a handful
 * of seconds — sync has taken its share by then, and derivation sits behind it
 * in the graph's order.
 *
 * A share at all, rather than the rest of the window, because the jobs behind
 * this one are the ones that keep a full phone working: `evict` is what frees
 * the space a rendition is written into, and it is last in the order. A pass
 * that spent everything left would be a phone that derives until its disk is
 * full and then cannot derive again.
 *
 * Half rather than a smaller fraction because the unit is coarse. One record is
 * a decode and up to three encodes — `derive-ladder-cheap` budgets ten seconds
 * for it — so a share that leaves less than one record's worth of time is a job
 * that is scheduled and never does anything.
 */
export const DERIVE_DEADLINE_SHARE = 0.5;

/**
 * How long a background window waits for the media store.
 *
 * **Thirty seconds, and the number is chosen against the tick's budget rather
 * than against any measurement of the media store.** A query that answers takes
 * milliseconds once the watermark narrows it; the case this bounds is the one
 * where the promise never settles at all, which has been observed on a Pixel 5
 * in a process with no activity. See `ListRecentOptions.timeoutMs`.
 *
 * A third of the window — `TICK_BUDGET_MS` in `background-task.ts` — so a tick
 * that loses this race still has time to sync what earlier windows imported.
 * Import is the job that notices photographs and sync is the job that gets them
 * off the device, and of the two the second is the one a person is waiting on.
 *
 * Declared here rather than beside that budget so `platform.ts` can read it
 * without importing the module whose evaluation registers the OS task. See
 * `importRecentFor`.
 */
export const MEDIA_QUERY_TIMEOUT_MS = 30_000;

/**
 * What an outcome says while its job is still running.
 *
 * A progress snapshot has to describe a job that has not finished, and the only
 * honest thing to say about one is that it started. The string is a constant
 * because {@link inFlightJob} reads it back — a watchdog naming the wrong job
 * would be worse than a watchdog naming none.
 */
export const IN_FLIGHT_DETAIL = "started and did not return";

/**
 * Which job a progress snapshot was inside, or null between jobs.
 *
 * The tick appends the running job as an outcome that has not run, so the last
 * entry is the one the window is inside. See {@link TickDeps.onProgress}.
 */
export function inFlightJob(snapshot: TickReport): JobId | null {
  const last = snapshot.outcomes[snapshot.outcomes.length - 1];
  if (last === undefined) return null;
  return !last.ran && last.detail === IN_FLIGHT_DETAIL ? last.job : null;
}

/**
 * Run everything the conditions allow, in the graph's preferred order, until
 * the deadline.
 *
 * Never throws. One job failing is one job's outcome, not the window's: a
 * transfer that cannot complete must not stop the eviction pass that would free
 * the space it needs.
 */
export async function runWorkTick(deps: TickDeps, options: TickOptions): Promise<TickReport> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const start = now();
  const outcomes: JobOutcome[] = [];
  let ranOutOfTime = false;

  const snapshot = (inFlight: JobOutcome | null): TickReport => ({
    startedAt: new Date(start).toISOString(),
    device: deps.device,
    outcomes: inFlight === null ? [...outcomes] : [...outcomes, inFlight],
    ranOutOfTime,
    totalMs: now() - start,
  });
  const progress = (inFlight: JobOutcome | null): void => deps.onProgress?.(snapshot(inFlight));

  progress(null);
  for (const job of preferredOrder()) {
    if (now() >= options.deadlineMs) {
      ranOutOfTime = true;
      break;
    }

    if (UNBOUND_JOBS.includes(job)) {
      outcomes.push({ job, ran: false, detail: "no implementation on this device", ms: 0 });
      progress(null);
      continue;
    }

    const spec = jobSpec(job);
    if (!canRun(spec, deps.device)) {
      outcomes.push({ job, ran: false, detail: ruledOutBy(job, deps.device), ms: 0 });
      progress(null);
      continue;
    }

    const began = now();
    // Logged on entry as well as on exit. A line only on completion says
    // nothing at all about the job that never completes, which is exactly the
    // one worth naming — a window that hangs is otherwise indistinguishable
    // from a window that never started.
    log(`[tick] ${job}: starting`);
    progress({ job, ran: false, detail: IN_FLIGHT_DETAIL, ms: 0 });
    try {
      const detail = await runJob(job, deps, options, now);
      outcomes.push({ job, ran: true, detail, ms: now() - began });
      log(`[tick] ${job}: ${detail}`);
    } catch (err) {
      outcomes.push({ job, ran: false, detail: String(err), ms: now() - began });
      log(`[tick] ${job}: failed — ${String(err)}`);
    }
    progress(null);
  }

  return snapshot(null);
}

async function runJob(
  job: JobId,
  deps: TickDeps,
  options: TickOptions,
  now: () => number,
): Promise<string> {
  const { node } = deps;

  switch (job) {
    case "scan-media-store": {
      const outcome = await deps.importRecent(shareOf(options, now, IMPORT_DEADLINE_SHARE));
      // Named rather than left as three zeroes. A seeding pass and an empty
      // camera roll produce identical counts and mean opposite things — one is
      // a node that has just learned where "now" is, the other is a node with
      // nothing to do — and the first is what every fresh install reports once.
      if (outcome.cursorSeeded) return "watermark established — nothing imported on a first look";
      return `imported=${outcome.imported} skipped=${outcome.skipped} failed=${outcome.failed}`;
    }

    // One call covers two jobs, and the loop reaches this branch only under the
    // stricter of the two. `MobileNode.sync()` moves metadata and blobs
    // together, while the graph lets `sync-metadata` run on cellular and holds
    // `push-blobs` to an unmetered connection. Running the pair on a metered
    // connection would push originals under a constraint that exists to prevent
    // exactly that, so the pair waits for Wi-Fi. The cost is real and is stated
    // rather than hidden: a phone that only ever sees cellular exchanges no
    // metadata in the background. Splitting it belongs in the engine, where a
    // metadata-only round can be expressed, rather than here.
    case "sync-metadata": {
      if (!canRun(jobSpec("push-blobs"), deps.device)) {
        return "skipped — sync moves blobs too, and this connection is metered";
      }
      // The share exists so the jobs after sync still get a window. See
      // SYNC_DEADLINE_SHARE.
      const result = await node.sync({ signal: shareOf(options, now, SYNC_DEADLINE_SHARE) });
      if (result === null) return "no cloud on this node — nothing to exchange";
      return (
        `rounds=${result.rounds} applied=${result.applied} shipped=${result.shipped} ` +
        `elided=${result.elided} complete=${result.complete} stalled=${result.stalled}`
      );
    }

    // The one job whose binding can be absent from a *build* rather than from
    // the graph, so its two "did nothing" answers are different sentences. No
    // callback at all is a caller that offers no derivation; a null outcome is a
    // device that cannot derive — no camera roll to walk, or no encoder in the
    // binary. Both are ordinary, and neither is a failure.
    case "derive-ladder-cheap": {
      if (!deps.deriveRenditions) return "nothing here derives renditions";
      const outcome = await deps.deriveRenditions(
        shareOf(options, now, DERIVE_DEADLINE_SHARE),
      );
      if (outcome === null) return "this device cannot derive — no encoder, or no camera roll";
      return (
        `decoded=${outcome.scanned} rungs=${outcome.written} ` +
        `failed=${outcome.failed} complete=${outcome.complete}`
      );
    }

    // Already done by the `sync-metadata` branch, which moves both. Reported
    // rather than dropped, so the graph's eight jobs all appear in the report
    // and nobody reads a missing line as a job that failed.
    case "push-blobs":
      return "covered by the sync round above";

    case "scan-acquirable": {
      const outcome = await node.scanForAcquirable();
      return `queued=${outcome.queued} complete=${outcome.complete}`;
    }

    case "fetch-blobs": {
      const outcomes = await node.acquireQueued();
      return `acquired=${outcomes.length}`;
    }

    case "evict": {
      const outcomes = await node.reclaimSpace();
      const triggered = outcomes.filter((o) => o.triggered);
      const freed = triggered.reduce((sum, o) => sum + (o.bytesBefore - o.bytesAfter), 0);
      // The refusal is carried rather than counted. On a device with no peer to
      // ask, eviction frees nothing *and says why* — and "the budget is full"
      // with no explanation is the report that sends someone looking for a bug
      // in the pass that is behaving correctly.
      const refused = outcomes.find((o) => o.refusal !== null)?.refusal;
      return (
        `passes=${outcomes.length} triggered=${triggered.length} freedBytes=${freed}` +
        (refused ? ` refused=${refused}` : "")
      );
    }

    default:
      return "not bound";
  }
}

/**
 * A signal that trips once this job has used its share of what is left.
 *
 * A getter over the clock rather than a timer: nothing has to be scheduled,
 * nothing has to be cleared, and a headless context about to be frozen leaves
 * nothing running behind it.
 */
function shareOf(
  options: TickOptions,
  now: () => number,
  share: number,
): { readonly aborted: boolean } {
  const remaining = Math.max(0, options.deadlineMs - now());
  const deadline = now() + Math.floor(remaining * share);
  return {
    get aborted(): boolean {
      return now() > deadline;
    },
  };
}

/**
 * Which condition ruled a job out.
 *
 * Named rather than counted. A report saying four jobs did not run is a report
 * nobody can act on, and the whole reason the graph is data is that its
 * decisions are inspectable.
 */
function ruledOutBy(job: JobId, device: DeviceState): string {
  const { constraints } = jobSpec(job);
  if (constraints.requiresNetwork && !device.hasNetwork) return "no network";
  if (constraints.requiresUnmetered && !device.isUnmetered) return "connection is metered";
  if (constraints.requiresCharging && !device.isCharging) return "not charging";
  if (constraints.requiresStorageNotLow && device.isStorageLow) return "storage is low";
  if (job === "derive-ladder-full") return "battery below the floor for expensive rungs";
  return "conditions not met";
}
