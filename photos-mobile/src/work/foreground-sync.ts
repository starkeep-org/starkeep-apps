/**
 * Syncing while the app is open.
 *
 * Opening the app used to run one catch-up pass and nothing after it: a phone
 * left open on the grid never synced again, and a photograph taken while it was
 * open waited for the next time somebody switched away and back. The first
 * sync of a pass also waited for import, four backfills and derivation, which
 * on a real camera roll is tens of seconds before a single row leaves.
 *
 * Three rules close that, and they live here so they run in Node against fakes
 * — `HomeScreen` performs them and decides nothing:
 *
 *   - **Sync right after import**, then again once derivation has made the new
 *     rungs. A sync already running when the second is asked for runs the
 *     second when it finishes, rather than dropping it. See
 *     {@link createSyncFollowUp}.
 *   - **Sync every {@link FOREGROUND_SYNC_INTERVAL_MS} while open.** See
 *     {@link createForegroundSyncLoop}.
 *   - **Import and sync when the camera roll changes** while open, a few
 *     seconds after the last change. See {@link createDebouncer}.
 *   - **Upload continuously while open on Wi-Fi.** See {@link uploadsMayRun}.
 *
 * Every automatic sync keeps the Wi-Fi gate the catch-up pass already had
 * (decision 3 of `plan-sync-latency-fixes-2026-10-14.md`): `MobileNode.sync()`
 * moves originals as well as rows, and an original over cellular is the one
 * thing on this device that costs a person money. "Sync now" stays the
 * unconstrained override. Background windows are untouched.
 */

import { canRun, jobSpec, type DeviceState } from "./job-graph";

/**
 * How often an open app syncs when nothing else has asked it to.
 *
 * Matches the desktop's poll interval, so a phone and a desktop both open see
 * each other's work within a minute at worst. A sync with nothing to do is one
 * small exchange, so the steady-state cost is a request every half minute while
 * somebody is looking at the screen.
 */
export const FOREGROUND_SYNC_INTERVAL_MS = 30_000;

/**
 * How long the camera roll has to be quiet before a change is acted on.
 *
 * A burst of photographs fires a change per photograph, and a screen recording
 * or a large download can fire dozens; acting on each would start an import per
 * event. A few seconds of quiet is one import for the whole burst, and still
 * arrives while the person is looking for the photograph they just took.
 */
export const MEDIA_CHANGE_DEBOUNCE_MS = 3_000;

/** What an automatic sync depends on. */
export interface AutoSyncState {
  readonly nodeReady: boolean;
  /** This node has somewhere to sync to. False on a device nobody signed in. */
  readonly hasCloud: boolean;
  /** Null when the device's conditions could not be read. */
  readonly device: DeviceState | null;
}

/**
 * Whether an automatic sync may run now: a node with a cloud, on a connection
 * this device may upload originals over. The same gate the catch-up pass uses.
 */
export function mayAutoSync(state: AutoSyncState): boolean {
  return (
    state.nodeReady &&
    state.hasCloud &&
    state.device !== null &&
    canRun(jobSpec("push-blobs"), state.device)
  );
}

/**
 * Whether the uploader may run continuously now: the app in the foreground,
 * under the same gate as an automatic sync. Uploads are where originals cross
 * the network, so they keep the Wi-Fi rule; background windows drain the
 * queue through the `push-blobs` job instead, under the job graph's rule.
 */
export function uploadsMayRun(state: AutoSyncState & { readonly foreground: boolean }): boolean {
  return state.foreground && mayAutoSync(state);
}

/**
 * At most one sync running and at most one waiting behind it.
 *
 * A sync asked for while one runs is not redundant: the running one may have
 * scanned before the rows this caller wants shipped existed — the rungs a
 * derivation pass just made, a photograph imported a moment ago. Dropping the
 * request would leave them for the next timer tick; running a second sync
 * concurrently would serialize behind the first anyway and double its
 * progress counter. So the request is remembered, and many requests while one
 * sync runs collapse into one follow-up.
 */
export interface SyncFollowUp {
  /** Ask for a sync. `"start"` means start one now; `"queued"` means one will follow. */
  request(): "start" | "queued";
  /** The running sync ended. True means start the follow-up now. */
  finished(): boolean;
  /** Forget any waiting follow-up, for the app leaving the foreground. */
  cancel(): void;
  /** Whether a sync is running, as far as this tracker knows. */
  running(): boolean;
}

export function createSyncFollowUp(): SyncFollowUp {
  let isRunning = false;
  let pending = false;
  return {
    request() {
      if (isRunning) {
        pending = true;
        return "queued";
      }
      isRunning = true;
      return "start";
    },
    finished() {
      if (pending) {
        pending = false;
        return true;
      }
      isRunning = false;
      return false;
    },
    cancel() {
      pending = false;
    },
    running() {
      return isRunning;
    },
  };
}

/** The timer functions the loops need, injectable so tests can drive time. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Run `onTick` every `intervalMs` while started.
 *
 * A chain of timeouts rather than an interval, and each one armed only after
 * the previous tick's promise settles: a sync that takes longer than the
 * interval must not have a second tick queue up behind it. Stopping cancels
 * the next tick; a tick already running finishes, and arms nothing.
 */
export interface ForegroundSyncLoop {
  start(): void;
  stop(): void;
  readonly running: boolean;
}

export function createForegroundSyncLoop(options: {
  readonly onTick: () => Promise<void> | void;
  readonly intervalMs?: number;
  readonly timers?: Timers;
}): ForegroundSyncLoop {
  const intervalMs = options.intervalMs ?? FOREGROUND_SYNC_INTERVAL_MS;
  const timers = options.timers ?? realTimers;
  let handle: unknown = null;
  let started = false;

  const arm = (): void => {
    handle = timers.setTimeout(() => {
      handle = null;
      void Promise.resolve()
        .then(options.onTick)
        .catch(() => {})
        .finally(() => {
          if (started) arm();
        });
    }, intervalMs);
  };

  return {
    start() {
      if (started) return;
      started = true;
      arm();
    },
    stop() {
      started = false;
      if (handle !== null) timers.clearTimeout(handle);
      handle = null;
    },
    get running() {
      return started;
    },
  };
}

/**
 * Call `fn` once, `ms` after the last of a burst of `trigger()` calls.
 */
export interface Debouncer {
  trigger(): void;
  cancel(): void;
}

export function createDebouncer(fn: () => void, ms = MEDIA_CHANGE_DEBOUNCE_MS, timers: Timers = realTimers): Debouncer {
  let handle: unknown = null;
  return {
    trigger() {
      if (handle !== null) timers.clearTimeout(handle);
      handle = timers.setTimeout(() => {
        handle = null;
        fn();
      }, ms);
    },
    cancel() {
      if (handle !== null) timers.clearTimeout(handle);
      handle = null;
    },
  };
}
