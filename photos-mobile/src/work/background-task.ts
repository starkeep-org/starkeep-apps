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
 * wiring and nothing decidable. What the phone should *do* belongs in modules
 * that a laptop can test — today {@link runProbe}, and the work tick that
 * replaces it once the probe's four questions have answers.
 */

import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import {
  bringUpNode,
  deviceMedia,
  documentPath,
  expoFileSystem,
} from "../platform";
import { runProbe } from "./probe";
import { createProbeReportStore } from "./probe-report-store";

/**
 * The task's name, as WorkManager and `TaskManager` both know it.
 *
 * Stable across releases deliberately: `registerTaskAsync` keys on it, and a
 * rename would orphan whatever the OS has already scheduled under the old one
 * rather than replace it.
 */
export const BACKGROUND_WORK_TASK = "starkeep-photos-background-work";

const PROBE_REPORT_PATH = documentPath("starkeep", "probe-report.json");
const PROBE_REPORT_DIR = documentPath("starkeep");

export const probeReportStore = createProbeReportStore(
  expoFileSystem,
  PROBE_REPORT_PATH,
  PROBE_REPORT_DIR,
);

/**
 * How often the OS is asked to run the task, in minutes.
 *
 * Fifteen is WorkManager's floor rather than a preference, and it is a floor on
 * the *delay* rather than a promise about the cadence: a phone deep in Doze
 * defers a delayed request into its maintenance windows, so an idle handset can
 * go hours between runs. Asking for less than the floor gets the floor; asking
 * for more gets exactly what was asked. Fifteen is therefore the honest way to
 * say "as soon as the platform will allow".
 */
export const MINIMUM_INTERVAL_MINUTES = 15;

TaskManager.defineTask(BACKGROUND_WORK_TASK, async () => {
  try {
    const report = await runProbe({
      media: deviceMedia,
      openNode: async () => (await bringUpNode()).node,
      writeReport: (result) => probeReportStore.write(result),
    });
    // Success whatever the steps found. A failed step is an answer rather than
    // an error, and reporting `Failed` to WorkManager for a probe that ran and
    // learned something would back the task off for doing its job.
    void report;
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
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
