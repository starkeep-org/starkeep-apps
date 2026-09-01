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
  readonly device: DeviceState;
  readonly outcomes: readonly JobOutcome[];
  /** True when the deadline closed the window before every job was considered. */
  readonly ranOutOfTime: boolean;
  readonly totalMs: number;
}

/**
 * Jobs the graph declares and this device cannot yet perform.
 *
 * Named here rather than silently skipped. The phone derives nothing — there is
 * no encoder on it — so binding a derive job would mean scheduling work with no
 * implementation behind it, and the honest report says which of the graph's
 * eight jobs are actually wired.
 */
export const UNBOUND_JOBS: readonly JobId[] = ["derive-ladder-cheap", "derive-ladder-full"];

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
  }) => Promise<{ imported: number; skipped: number; failed: number }>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
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

  for (const job of preferredOrder()) {
    if (now() >= options.deadlineMs) {
      ranOutOfTime = true;
      break;
    }

    if (UNBOUND_JOBS.includes(job)) {
      outcomes.push({ job, ran: false, detail: "no implementation on this device", ms: 0 });
      continue;
    }

    const spec = jobSpec(job);
    if (!canRun(spec, deps.device)) {
      outcomes.push({ job, ran: false, detail: ruledOutBy(job, deps.device), ms: 0 });
      continue;
    }

    const began = now();
    // Logged on entry as well as on exit. A line only on completion says
    // nothing at all about the job that never completes, which is exactly the
    // one worth naming — a window that hangs is otherwise indistinguishable
    // from a window that never started.
    log(`[tick] ${job}: starting`);
    try {
      const detail = await runJob(job, deps, options, now);
      outcomes.push({ job, ran: true, detail, ms: now() - began });
      log(`[tick] ${job}: ${detail}`);
    } catch (err) {
      outcomes.push({ job, ran: false, detail: String(err), ms: now() - began });
      log(`[tick] ${job}: failed — ${String(err)}`);
    }
  }

  return {
    startedAt: new Date(start).toISOString(),
    device: deps.device,
    outcomes,
    ranOutOfTime,
    totalMs: now() - start,
  };
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
