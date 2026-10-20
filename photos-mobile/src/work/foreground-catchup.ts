/**
 * What to do when the app comes to the foreground.
 *
 * ## Why this is a module and not a screen effect
 *
 * Opening the app is the strongest signal this app ever gets that a person
 * wants their library current, and until now it was ignored: the screen resumed
 * a sync only when backgrounding had interrupted one. A photograph taken thirty
 * seconds ago entered the node when somebody tapped "Add photos from this
 * device", or when a background window fired up to fifteen minutes later.
 *
 * The rules for closing that gap are decisions rather than platform calls —
 * whether the permission is already held, whether the connection is one this
 * device may upload originals over, whether the last pass was recent enough to
 * skip — so they live here and run in Node against fakes, like every other
 * decidable module in this app. `HomeScreen` performs the plan and decides
 * nothing.
 */

import { canRun, jobSpec, type DeviceState } from "./job-graph";

/**
 * How long a completed pass suppresses the next one.
 *
 * **A minute, and the number is about how many `active` transitions one
 * intention produces rather than about how often a camera roll changes.**
 * Returning from the permission dialog, from the sign-in screen and from the
 * system share sheet each deliver an `active` transition, and so does every
 * glance at another app and back. Without a floor, one person doing one thing
 * starts three passes, each of which reads the media store and opens a sync.
 *
 * A minute is short enough that a photograph taken and then looked for arrives
 * on the second attempt, and long enough that the ordinary churn of app
 * switching costs nothing.
 */
export const CATCH_UP_MIN_INTERVAL_MS = 60_000;

/** Everything the decision depends on, gathered by the caller. */
export interface CatchUpState {
  readonly nodeReady: boolean;
  /** A sync is already running, from a tap or from an earlier pass. */
  readonly syncing: boolean;
  /**
   * The media permission is **already** granted.
   *
   * Read with `getPermissions`, never requested. The one request is the
   * first-open ask in `useForegroundWork`, and a catch-up that raised the
   * dialog again would ask on every return to the foreground.
   */
  readonly mediaPermissionGranted: boolean;
  /** This node has somewhere to sync to. False on a device nobody signed in. */
  readonly hasCloud: boolean;
  /** Null when the device's conditions could not be read this pass. */
  readonly device: DeviceState | null;
  /** When the last pass that actually ran finished, or null if none has. */
  readonly lastRunMs: number | null;
  readonly nowMs: number;
}

/** Which halves of a catch-up pass to run. */
export interface CatchUpPlan {
  readonly import: boolean;
  readonly sync: boolean;
}

const NOTHING: CatchUpPlan = { import: false, sync: false };

/**
 * What a foreground pass should do right now.
 *
 * ## Sync waits for an unmetered connection and "Sync now" does not
 *
 * `MobileNode.sync()` moves rows and blobs together, so an automatic pass on a
 * metered connection uploads originals over cellular — the one thing on this
 * device that costs a person money, and the exact constraint `push-blobs`
 * exists to state. So the automatic half asks the job graph, and the button
 * stays the unconstrained override: a tap is a person deciding to spend their
 * own data, which is a decision nobody else gets to make for them.
 */
export function planCatchUp(state: CatchUpState): CatchUpPlan {
  // Nothing to run against. Not a decline — there is no node yet, and the
  // screen already says the node is opening.
  if (!state.nodeReady) return NOTHING;

  // `runSync` guards its own re-entry, so a second caller would serialize
  // behind the first and double the progress counter on the way. Import would
  // race the sync it is meant to feed, too.
  if (state.syncing) return NOTHING;

  // Recent enough that this transition is almost certainly the same intention
  // as the last one. See CATCH_UP_MIN_INTERVAL_MS.
  if (
    state.lastRunMs !== null &&
    state.nowMs - state.lastRunMs < CATCH_UP_MIN_INTERVAL_MS
  ) {
    return NOTHING;
  }

  const mayImport = state.mediaPermissionGranted;
  const maySync =
    state.hasCloud && state.device !== null && canRun(jobSpec("push-blobs"), state.device);

  return {
    import: mayImport,
    sync: maySync,
  };
}
