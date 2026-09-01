/**
 * Timers that fire in a headless process.
 *
 * ## Why the platform's will not do
 *
 * React Native drives `setTimeout` from a `Choreographer` frame callback, and a
 * process started for `SystemJobService` on a handset with the screen off gets
 * no frames. Measured on a Pixel 5: timers armed at five and twenty seconds had
 * not fired three minutes later, while `Network.getNetworkStateAsync()` resolved
 * in five milliseconds in the same context. Three bounds were written against
 * that failure before it was understood, and all three were unreachable when it
 * happened.
 *
 * `modules/starkeep-timer` schedules on a `ScheduledThreadPoolExecutor` in
 * Kotlin instead, which touches neither the display nor the main looper. This
 * file is the adapter between that module and the `Timers` seam every deadline
 * in the app takes.
 *
 * ## What may not live here
 *
 * Anything decidable. This file cannot run under Node, so it holds the wiring
 * and the singleton and nothing else; the races are in `deadline.ts` and the
 * window rule is in `window-guard.ts`.
 */

import StarkeepTimer, {
  type StarkeepTimer as StarkeepTimerModule,
} from "../../modules/starkeep-timer";
import { REAL_TIMERS, type Timers } from "../deadline";
import { createWindowGuard } from "./window-guard";

/**
 * Handles are the caller's, not the platform's.
 *
 * The native side takes an id rather than handing one back, because a handle
 * that arrives with a resolved promise arrives too late to cancel the delay it
 * belongs to.
 */
let nextHandle = 1;

/**
 * The native timers, or the platform's when the module is not in the binary.
 *
 * The fallback is a development-client convenience and nothing more: the
 * platform's timers are exactly what does not work in the context these exist
 * for, so a build that takes this branch has no working bound in a background
 * window. It says so, once, rather than failing silently the way the original
 * defect did.
 */
export const nativeTimers: Timers = timersFor(StarkeepTimer);

function timersFor(module: StarkeepTimerModule | null): Timers {
  if (module === null) {
    console.warn(
      "[timers] StarkeepTimer is not in this binary — background deadlines will not fire",
    );
    return REAL_TIMERS;
  }
  return {
    setTimeout(handler: () => void, ms: number): unknown {
      const handle = nextHandle++;
      void module.delay(handle, Math.max(0, Math.round(ms))).then(
        (fired) => {
          if (fired) handler();
        },
        // A rejected delay is a delay that will not fire, which is what a
        // cleared timer looks like too. Nothing downstream can act on the
        // difference.
        () => undefined,
      );
      return handle;
    },
    clearTimeout(handle: unknown): void {
      if (typeof handle === "number") module.cancel(handle);
    },
  };
}

/**
 * The one window guard, shared by the node's network calls and the task that
 * opens the window.
 *
 * A singleton because the node is built once at launch and serves both the
 * screen and every later background tick. See `window-guard.ts`.
 */
export const backgroundWindow = createWindowGuard({ timers: nativeTimers });
