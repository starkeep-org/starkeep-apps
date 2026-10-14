/**
 * Prefix every console line this thread writes with the wall-clock time.
 *
 * admin-web hands Photos a plain file descriptor for stdout and stderr, so
 * nothing downstream stamps a line. A derive sweep that logs
 * `published=none` without a time cannot be placed against the sync round that
 * brought the record, and that placement is the question a sync-latency
 * investigation asks. See `findings-phone-to-desktop-sync-latency-2026-10-14.md`.
 *
 * Per thread, not per process: a worker thread has its own `console`, so the
 * server and each worker entry point import this first.
 *
 * Local time with its UTC offset, matching the local data server's log, so the
 * two read side by side.
 */

export function localIsoTimestamp(date: Date = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const STAMPED = Symbol.for("starkeep.console.timestamped");

export function timestampConsole(): void {
  const target = console as Console & { [STAMPED]?: boolean };
  // `tsx watch` re-evaluates modules on reload; a line must not gain a second
  // stamp each time.
  if (target[STAMPED]) return;
  target[STAMPED] = true;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => original(localIsoTimestamp(), ...args);
  }
}

timestampConsole();
