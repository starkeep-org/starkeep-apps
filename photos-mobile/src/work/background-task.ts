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
import { importDeviceMedia } from "../media/import";
import { acquireNode } from "./node-handle";
import { readDeviceState } from "./device-state";
import { runWorkTick, type TickReport } from "./tick";
import type { DeviceState } from "./job-graph";
import { createTickReportStore } from "./tick-report-store";

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
 * WorkManager stops a worker at ten minutes, and a worker stopped mid-write is
 * not a failure here — every job is resumable and every round persists its own
 * watermarks — but it is a window whose report never gets written. Nine minutes
 * leaves room to finish, record what happened and hand the database back.
 */
export const TICK_BUDGET_MS = 9 * 60_000;

/**
 * How many of the newest assets one tick considers importing.
 *
 * Generous because the pass is cheap for anything already imported — an alias
 * lookup and a record read — and because the cost of being stingy is invisible.
 * Import walks the media store newest-first, so a limit that falls short of a
 * burst leaves the older half of it permanently unseen: the next tick looks at
 * the same newest N, finds them already imported, and stops.
 *
 * Two hundred covers any plausible burst between two windows. It does not cover
 * a library backfill, and is not meant to — bringing in sixty thousand older
 * photographs stays a foreground action with a progress count somebody can see.
 */
export const TICK_IMPORT_LIMIT = 200;

TaskManager.defineTask(BACKGROUND_WORK_TASK, async () => {
  let report: TickReport | null = null;
  const lease = await acquireNode().catch(() => null);
  if (lease === null) return BackgroundTask.BackgroundTaskResult.Failed;

  try {
    const device = await readRealDeviceState();

    const clock = createHLCClock({ nodeId: lease.identity.nodeId });
    report = await runWorkTick(
      {
        node: lease.node,
        device,
        importRecent: async (signal) => {
          const outcome = await importDeviceMedia(importDepsFor(lease.node, clock), {
            limit: TICK_IMPORT_LIMIT,
            signal,
          });
          return {
            imported: outcome.imported,
            skipped: outcome.skipped,
            failed: outcome.failed,
          };
        },
      },
      { deadlineMs: Date.now() + TICK_BUDGET_MS },
    );
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  } finally {
    // Both in the `finally`, and the order matters. The report is what a person
    // sees on the next launch, so it is written even for a tick that threw —
    // and the database is handed back whatever happened, because a headless
    // process about to be frozen with SQLite open is how the next launch finds
    // a lock nobody holds.
    if (report !== null) {
      try {
        tickReportStore.write(report);
      } catch {
        // A report that cannot be written is not a reason to fail the window.
      }
    }
    await lease.release().catch(() => undefined);
  }
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
