/**
 * The phone's background work, as the OS sees it.
 *
 * ## Why the definition is at module scope
 *
 * `TaskManager.defineTask` has to have run before the OS asks for the task, and
 * on a headless launch there is no React tree to have run it — the process
 * starts, evaluates the entry bundle, and immediately looks for a task by name.
 * A definition inside a component would be registered only on the path where it
 * is least needed. So this module defines the task as a side effect of being
 * imported, and `index.ts` imports it for that reason and no other.
 *
 * The import order in `index.ts` is load-bearing for the same reason it is
 * there already: `react-native-get-random-values` must win, because the node
 * this task opens reaches ulidx's PRNG probe on the way up.
 *
 * ## What this file may and may not contain
 *
 * It joins `platform.ts` as a file that cannot run under Node, so it holds
 * wiring and nothing decidable. What the phone should *do* lives in `tick.ts`
 * and `device-state.ts`, which a laptop can test against fakes.
 */

import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { Paths } from "expo-file-system";
import * as Network from "expo-network";
import { createHLCClock } from "@starkeep/protocol-primitives";
import { documentPath, expoFileSystem, importDepsFor } from "../platform";
import { importDeviceMedia, noYield } from "../media/import";
import { acquireNode } from "./node-handle";
import { readDeviceState } from "./device-state";
import { inFlightJob, runWorkTick, type TickReport } from "./tick";
import type { DeviceState } from "./job-graph";
import { createTickReportStore } from "./tick-report-store";
import { claimFor, decideClaim, type Claim } from "./single-flight";
import { EXPIRED, raceDeadline } from "../deadline";
import { backgroundWindow, nativeTimers } from "./native-timers";

/**
 * The task's name, as WorkManager and `TaskManager` both know it.
 *
 * Stable across releases deliberately: `registerTaskAsync` keys on it, and a
 * rename would orphan whatever the OS has already scheduled under the old one
 * rather than replace it.
 */
export const BACKGROUND_WORK_TASK = "starkeep-photos-background-work";

export const tickReportStore = createTickReportStore(
  expoFileSystem,
  documentPath("starkeep", "tick-report.json"),
  documentPath("starkeep"),
);

/**
 * How often the OS is asked to run the task, in minutes.
 *
 * Fifteen is WorkManager's floor rather than a preference, and it is a floor on
 * the *delay* rather than a promise about the cadence: a phone deep in Doze
 * defers a delayed request into its maintenance windows, so an idle handset can
 * go hours between runs. Asking for less than the floor gets the floor. Fifteen
 * is therefore the honest way to say "as soon as the platform will allow".
 */
export const MINIMUM_INTERVAL_MINUTES = 15;

/**
 * How long one tick may take.
 *
 * **Ninety seconds, revised down from nine minutes, and the ceiling it is sized
 * against changed rather than the reasoning.** Nine minutes was chosen against
 * WorkManager's ten-minute stop, which is the right bound for a single window
 * and the wrong bound for a day.
 *
 * An app nobody opens sits in Android's RARE standby bucket, and RARE grants
 * **ten minutes of background execution and three job sessions per twenty-four
 * hours** (`qc_allowed_time_per_period_rare_ms`, `qc_max_session_count_rare`).
 * Measured on a Pixel 5 the app had spent forty minutes across eight sessions
 * and was locked out for the following twenty-two hours. A nine-minute budget
 * therefore does not bound a tick against the day's allowance — it spends the
 * entire allowance on one window, by design.
 *
 * Ninety seconds turns the same allowance into six or seven windows. Every job
 * in the graph is resumable precisely so that a short window is enough, and a
 * sync round persists its own watermarks, so the cost of stopping is the round
 * in flight and nothing else.
 */
export const TICK_BUDGET_MS = 90_000;

/**
 * How many assets one tick considers importing.
 *
 * **Twenty, and what the number bounds has changed.** It used to bound the
 * newest twenty assets on the device, imported or not, because the media-store
 * probe behind `exeForMetadata()` is paid per returned row and is not
 * interruptible — two hundred measured at 18.8 minutes on a Pixel 5, and twenty
 * still measured at over nine and a half against a roll with one new photograph
 * in it.
 *
 * The tick now passes an import watermark, so the query returns only assets
 * that have appeared or changed since the last window. Twenty is a backlog page
 * rather than a scan width: a quiet phone returns nothing and pays nothing, and
 * a burst of a hundred captures drains twenty per window, oldest first, without
 * losing any of them. See `media/import-cursor.ts`.
 *
 * The limitation the old number carried is therefore gone. What remains is the
 * seeding pass — a node that has never imported establishes the watermark and
 * imports nothing, leaving a pre-existing camera roll to the foreground "Add
 * photos" control, which takes sixty at a time and shows a progress count.
 */
export const TICK_IMPORT_LIMIT = 20;

/**
 * How long a background window waits for the media store.
 *
 * **Thirty seconds, and the number is chosen against the tick's budget rather
 * than against any measurement of the media store.** A query that answers takes
 * milliseconds once the watermark narrows it; the case this bounds is the one
 * where the promise never settles at all, which has been observed on a Pixel 5
 * in a process with no activity. See `ListRecentOptions.timeoutMs`.
 *
 * A third of the window, so a tick that loses this race still has time to sync
 * what earlier windows imported. Import is the job that notices photographs and
 * sync is the job that gets them off the device, and of the two the second is
 * the one a person is waiting on.
 */
export const MEDIA_QUERY_TIMEOUT_MS = 30_000;

/**
 * How long after its own budget a tick is given to finish tidily.
 *
 * The tick checks the clock between jobs and every sync round checks it too, so
 * a tick that reaches its budget normally stops itself, writes its report and
 * releases the node. The watchdog exists for the other case — a call that never
 * returns — and firing the two at the same instant would race an orderly finish
 * against a watchdog that reports the window abandoned. Five seconds is longer
 * than the tidying has ever taken and short enough to leave the day's allowance
 * essentially untouched.
 */
export const WATCHDOG_GRACE_MS = 5_000;

/**
 * The task's own progress, either side of everything that can block.
 *
 * The tick reports per job, and that says nothing about the work either side of
 * the jobs — opening the node and handing it back. A window that produced no
 * output at all was indistinguishable from a process that never woke, and
 * bringing the node up is exactly where a second connection to a database the
 * previous window has not finished closing would wait.
 */
function taskLog(line: string): void {
  console.warn(`[task] ${line}`);
}

/**
 * The tick currently running, if any, and until when it may claim to be.
 *
 * The rule and the reasoning behind it live in `single-flight.ts`, which is
 * where they can be tested. In short: a window is one tick, because the OS has
 * delivered this task twice thirty milliseconds apart into one runtime — and a
 * claim expires, because a tick frozen mid-call otherwise holds the process
 * forever and drops every delivery that would have replaced it.
 *
 * A deferred delivery returns immediately rather than awaiting the holder. The
 * OS wants each delivery acknowledged, the work it would have done is already
 * being done, and making it wait would report one tick's duration twice.
 */
let inFlight: (Claim & { readonly promise: Promise<unknown> }) | null = null;

TaskManager.defineTask(BACKGROUND_WORK_TASK, async () => {
  const decision = decideClaim(inFlight, Date.now());
  if (decision.kind === "defer") {
    taskLog("a tick is already running in this process — this delivery does nothing");
    return BackgroundTask.BackgroundTaskResult.Success;
  }
  if (decision.kind === "take-over") {
    // Named, with the number, because this line is the whole difference between
    // a diagnosable wedge and a silent one. See `single-flight.ts`.
    taskLog(
      `the previous tick outlived its claim by ${decision.overdueByMs}ms — taking the process over`,
    );
  }
  let resolveInFlight: () => void = () => undefined;
  const claim = {
    ...claimFor(Date.now(), TICK_BUDGET_MS),
    promise: new Promise<void>((resolve) => {
      resolveInFlight = resolve;
    }),
  };
  inFlight = claim;
  // Only ever clears *this* delivery's claim. A tick that expired, was taken
  // over, and then thawed and ran its `finally` anyway would otherwise release
  // the claim belonging to the tick that replaced it — reintroducing the
  // overlapping ticks the guard exists to prevent, and doing it in the one
  // state where two of them are least affordable.
  const releaseClaim = (): void => {
    if (inFlight === claim) inFlight = null;
    resolveInFlight();
  };

  const startedAt = Date.now();
  const deadlineMs = startedAt + TICK_BUDGET_MS;
  /**
   * Where the window is, in words.
   *
   * The stages either side of the tick are not jobs and produce no outcome of
   * their own, and opening the node is exactly where the first observed wedge
   * happened. "The window was abandoned" with nothing after it is a report
   * nobody can act on.
   */
  let stage = "acquiring the node";
  /** The report the watchdog writes if the window never gets to write its own. */
  let progress: TickReport = {
    startedAt: new Date(startedAt).toISOString(),
    device: null,
    outcomes: [],
    ranOutOfTime: false,
    totalMs: 0,
  };

  const writeReport = (report: TickReport): void => {
    try {
      tickReportStore.write(report);
      taskLog("report written");
    } catch (err) {
      // A report that cannot be written is not a reason to fail the window.
      taskLog(`could not write the report: ${String(err)}`);
    }
  };

  // Every network call the node makes from here until the window closes is
  // bounded by the window. See `window-guard.ts`.
  backgroundWindow.open(deadlineMs);

  const window = (async (): Promise<BackgroundTask.BackgroundTaskResult> => {
    let report: TickReport | null = null;
    taskLog("awake, acquiring the node");
    const lease = await acquireNode().catch((err: unknown) => {
      taskLog(`could not acquire the node: ${String(err)}`);
      return null;
    });
    if (lease === null) {
      releaseClaim();
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
    taskLog("node acquired");

    try {
      stage = "reading the device";
      const device = await readRealDeviceState();
      taskLog(`device read: network=${device.hasNetwork} unmetered=${device.isUnmetered}`);

      stage = "running the tick";
      const clock = createHLCClock({ nodeId: lease.identity.nodeId });
      report = await runWorkTick(
        {
          node: lease.node,
          device,
          importRecent: async (signal) => {
            // The watermark is what makes this job affordable in a background
            // window. Supplied here and nowhere else: the foreground control
            // deliberately runs without one. See `ImportDeps.importCursor`.
            const outcome = await importDeviceMedia(
              {
                ...importDepsFor(lease.node, clock),
                importCursor: lease.node.importCursor ?? undefined,
                // Load-bearing in a headless process, where the default yield
                // is a `setTimeout` and would hang the loop forever on the
                // first asset worth importing. See `ImportDeps.yieldToUi`.
                yieldToUi: noYield,
              },
              {
                limit: TICK_IMPORT_LIMIT,
                signal,
                queryTimeoutMs: MEDIA_QUERY_TIMEOUT_MS,
                // The deadline is only a deadline if the timer behind it fires,
                // and the platform's does not here. See `native-timers.ts`.
                timers: nativeTimers,
              },
            );
            return {
              imported: outcome.imported,
              skipped: outcome.skipped,
              failed: outcome.failed,
              cursorSeeded: outcome.cursorSeeded ?? false,
            };
          },
          // Kept so the watchdog has something to write. Each snapshot names
          // the job in flight, so an abandoned window says which one it was.
          onProgress: (snapshot) => {
            progress = snapshot;
            stage = inFlightJob(snapshot) ?? "running the tick";
          },
        },
        { deadlineMs },
      );
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    } finally {
      // Both in the `finally`, and the order matters. The report is what a
      // person sees on the next launch, so it is written even for a tick that
      // threw — and the database is handed back whatever happened, because a
      // headless process about to be frozen with SQLite open is how the next
      // launch finds a lock nobody holds.
      if (report !== null) writeReport(report);
      stage = "releasing the node";
      taskLog("releasing the node");
      await lease.release().catch(() => undefined);
      // Cleared last, and in the `finally`, so a tick that threw does not leave
      // the process believing one is still running — which would silently stop
      // every future window in it.
      releaseClaim();
      taskLog("done");
    }
  })();

  const outcome = await raceDeadline(window, {
    ms: TICK_BUDGET_MS + WATCHDOG_GRACE_MS,
    timers: nativeTimers,
  });
  // Closed on both paths. A guard left open at a deadline in the past would
  // abort every foreground request the moment someone opened the app.
  backgroundWindow.close();
  if (outcome !== EXPIRED) return outcome;

  // The window is wedged on a call that will not return, and the only thing
  // still able to act is this watchdog. The node is deliberately not released:
  // whatever is wedged is most likely holding it, and a release that waits on
  // the same lock would wedge the watchdog too. A later delivery takes the
  // process over instead — see `single-flight.ts`.
  taskLog(`abandoned while ${stage} — the window is over and the work is not`);
  // Both fields re-based on the task's own start. The snapshot's `startedAt` is
  // the *tick's*, which begins after the node is open, while `totalMs` is
  // measured from the delivery — so carrying the snapshot's one unchanged
  // produced a report whose two numbers described different intervals, off by
  // however long SQLite took to open (2.8 s on a Pixel 5).
  writeReport({
    ...progress,
    startedAt: new Date(startedAt).toISOString(),
    totalMs: Date.now() - startedAt,
    abandoned: stage,
  });
  releaseClaim();
  return BackgroundTask.BackgroundTaskResult.Failed;
});

/**
 * Ask the OS to run the task from now on.
 *
 * Idempotent by way of the platform: `registerTaskAsync` against a name already
 * registered is a no-op, and the Android scheduler declines to replace work it
 * finds already enqueued or running. Calling it on every launch is therefore
 * the right shape — it is what re-establishes the schedule after the one event
 * that clears it, a force-stop from Settings.
 */
export async function registerBackgroundWork(): Promise<void> {
  await BackgroundTask.registerTaskAsync(BACKGROUND_WORK_TASK, {
    minimumInterval: MINIMUM_INTERVAL_MINUTES,
  });
}

/** Whether the OS is prepared to run background tasks for this app at all. */
export async function backgroundWorkStatus(): Promise<string> {
  const status = await BackgroundTask.getStatusAsync();
  return status === BackgroundTask.BackgroundTaskStatus.Available ? "available" : "restricted";
}

/**
 * The device conditions, read from the real modules.
 *
 * Exported so the screen shows the same reading the tick decides on. Two
 * readers with two sources is how a debug panel comes to disagree with the
 * scheduler it is meant to explain.
 */
export function readRealDeviceState(): Promise<DeviceState> {
  return readDeviceState({
    network: { getNetworkState: () => Network.getNetworkStateAsync() },
    disk: {
      readDisk: () => ({
        availableBytes: Paths.availableDiskSpace,
        totalBytes: Paths.totalDiskSpace,
      }),
    },
  });
}
