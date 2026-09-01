/**
 * What bounds the network for the length of a background window.
 *
 * ## The problem this solves
 *
 * React Native's `fetch` has no timeouts at all. `OkHttpClientProvider` builds
 * the client with connect, read and write timeouts set to zero, and both of
 * this app's network surfaces — the sync engine's HTTP transport and the remote
 * object storage adapter — go through it. In the foreground that is merely
 * impolite. In a background window it is the difference between a tick that
 * reports what it did and a process that holds the day's entire execution
 * allowance open on a stalled socket.
 *
 * ## Why the deadline is ambient rather than a parameter
 *
 * The node is built once, at launch, and the same node serves the screen and
 * the background task. A per-request deadline would therefore have to be
 * threaded from the task, through `bringUpNode`, through the sync engine, to a
 * `fetch` call the engine makes on its own schedule — across a package boundary
 * whose transport takes a `fetch` and nothing else.
 *
 * The window is the honest unit anyway. No request may outlive the window that
 * started it, whatever the request is for, and a window that is not open is the
 * foreground, where the platform's own timers work and a person can leave.
 */

import { abortAfter, type TimedAbort, type Timers } from "../deadline";

export interface WindowGuard {
  /** Bound everything from now until `deadlineAt`. */
  open(deadlineAt: number): void;
  /** Stop bounding. Requests already in flight keep the bound they were given. */
  close(): void;
  /** What is left of the open window, or null when none is open. */
  remainingMs(): number | null;
  /**
   * The same `fetch`, bounded by whatever window is open when each call is
   * made. Wrapping at construction and reading the window per request is what
   * lets one wrapper serve both the foreground and every later background tick.
   */
  boundFetch(inner: typeof globalThis.fetch): typeof globalThis.fetch;
  /**
   * A bound for one native transfer, or null in the foreground.
   *
   * Separate from {@link boundFetch} because expo-file-system's upload task is
   * not a `fetch` — it takes an `AbortSignal` of its own, and the caller has to
   * release the timer when the transfer settles.
   */
  transferAbort(): TimedAbort | null;
}

export function createWindowGuard(deps: {
  readonly timers: Timers;
  readonly now?: () => number;
}): WindowGuard {
  const now = deps.now ?? Date.now;
  let deadlineAt: number | null = null;

  const remainingMs = (): number | null =>
    deadlineAt === null ? null : Math.max(0, deadlineAt - now());

  return {
    open(at: number): void {
      deadlineAt = at;
    },
    close(): void {
      deadlineAt = null;
    },
    remainingMs,
    transferAbort(): TimedAbort | null {
      const remaining = remainingMs();
      return remaining === null ? null : abortAfter(remaining, deps.timers);
    },
    boundFetch(inner: typeof globalThis.fetch): typeof globalThis.fetch {
      return async (input, init) => {
        const remaining = remainingMs();
        if (remaining === null) return inner(input, init);
        const abort = abortAfter(remaining, deps.timers, init?.signal ?? undefined);
        try {
          return await inner(input, { ...init, signal: abort.signal });
        } finally {
          // Released when the response's headers arrive, not when its body has
          // been read. Reading the body is the caller's business and can itself
          // hang; the whole-window watchdog in `background-task.ts` is what
          // covers that, and holding one timer per request until the deadline
          // would cost more than it bought.
          abort.release();
        }
      };
    },
  };
}
