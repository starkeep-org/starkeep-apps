/**
 * Bounding a call that may never return.
 *
 * ## Why this is a file rather than three inline races
 *
 * Every bound in this app is a race against a timer, and on this platform the
 * timer is the part that is wrong. React Native drives `setTimeout` from a
 * `Choreographer` frame callback, and a headless process on a handset with the
 * screen off receives no frames, so a `setTimeout` armed inside a background
 * window never fires. The app therefore needs two timer implementations — the
 * platform's in the foreground, a native one in a background window — and every
 * bound has to take one rather than reach for the global.
 *
 * Collecting the race here is what makes that possible. `Timers` is the seam;
 * `native-timers.ts` supplies the background implementation, and everything
 * below is decidable in Node against a fake clock.
 */

/** The two calls a deadline needs, so a caller can supply its own clock. */
export interface Timers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * The platform's timers.
 *
 * Correct in the foreground and inert in a background window. Nothing that runs
 * in a background window may default to this — see `native-timers.ts`.
 */
export const REAL_TIMERS: Timers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** What {@link raceDeadline} resolves to when the deadline won. */
export const EXPIRED: unique symbol = Symbol("deadline expired");

export interface DeadlineOptions {
  /** How long the work has, in milliseconds. Omitted means no bound at all. */
  readonly ms?: number;
  readonly timers: Timers;
}

/**
 * The work's result, or {@link EXPIRED} once the deadline passes.
 *
 * The loser of the race is abandoned rather than cancelled, because the calls
 * this bounds cannot be cancelled: the work is native, reached across the
 * bridge, and this side holds only a promise. A leaked continuation in a
 * process the OS is about to reclaim costs nothing, and the alternative is a
 * window that reports nothing at all.
 */
export function raceDeadline<T>(
  work: Promise<T>,
  options: DeadlineOptions,
): Promise<T | typeof EXPIRED> {
  const { ms, timers } = options;
  if (ms === undefined) return work;
  return new Promise<T | typeof EXPIRED>((resolve, reject) => {
    const handle = timers.setTimeout(() => resolve(EXPIRED), Math.max(0, ms));
    work.then(
      (value) => {
        timers.clearTimeout(handle);
        resolve(value);
      },
      (err: unknown) => {
        timers.clearTimeout(handle);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export interface ThrowingDeadlineOptions extends DeadlineOptions {
  /** The error to throw once the deadline passes. */
  readonly onExpiry: () => Error;
}

/** The work's result, or the caller's error once the deadline passes. */
export async function withDeadline<T>(
  work: Promise<T>,
  options: ThrowingDeadlineOptions,
): Promise<T> {
  const outcome = await raceDeadline(work, options);
  if (outcome === EXPIRED) throw options.onExpiry();
  return outcome;
}

/** An abort signal and the timer holding it, which the caller must release. */
export interface TimedAbort {
  readonly signal: AbortSignal;
  /** Disarm the timer. Safe to call more than once, and after the abort. */
  readonly release: () => void;
}

/**
 * A signal that aborts once `ms` has passed, or as soon as `linked` does.
 *
 * Unlike the races above this one really does stop the work: an abort reaches
 * OkHttp through React Native's networking and closes the socket, so a stalled
 * request costs a connection rather than a window. Every caller must
 * {@link TimedAbort.release} when its request settles, because the timer would
 * otherwise stay armed for the whole deadline on a request that finished in
 * milliseconds.
 */
export function abortAfter(ms: number, timers: Timers, linked?: AbortSignal): TimedAbort {
  const controller = new AbortController();
  const handle = timers.setTimeout(() => controller.abort(), Math.max(0, ms));
  // A caller's own signal has to keep working through the wrapper. Linking
  // rather than choosing between the two: `AbortSignal.any` is not on Hermes,
  // and picking one would silently drop whichever bound was not picked.
  if (linked) {
    if (linked.aborted) controller.abort();
    else linked.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let released = false;
  return {
    signal: controller.signal,
    release: () => {
      if (released) return;
      released = true;
      timers.clearTimeout(handle);
    },
  };
}
