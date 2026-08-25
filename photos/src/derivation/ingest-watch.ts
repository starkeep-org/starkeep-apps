/**
 * Waking derivation when something lands, and once when the server starts.
 *
 * ## The two feeds, and why neither of them is the UI
 *
 * A sweep discovers work from a resumable cursor scan over the catalogue, which
 * covers everything: files copied while Photos was stopped, records synced from
 * another node, ladders left incomplete by a respecification. That is the
 * complete feed but not a prompt one — nothing tells it a file just arrived.
 *
 * The folder watcher lives in the local data server and already broadcasts a
 * change kick on its `/events` stream. Subscribing to it here is what makes a
 * newly landed file derive promptly rather than at the next sweep.
 *
 * The kick carries no record ids on purpose — `/events` is loopback-authorised
 * with no per-app filtering, and record-shaped information leaves that process
 * only through the grant-checked data plane. That suits this exactly: the
 * answer to "something changed" is "run the sweep", and the sweep's own query
 * decides what needs doing.
 *
 * ## Debounced, because a bulk copy is thousands of kicks
 *
 * Dropping a folder of ten thousand photos into a watched directory produces a
 * kick per file. Starting a sweep per kick would be ten thousand sweeps; waiting
 * for quiet and then running one is the same work, done once.
 */

import { isSweeping, startSweep } from "./sweep-controller";

/** How long the ingest stream must go quiet before a sweep starts. */
const DEBOUNCE_MS = 5_000;

/** How long after boot the first sweep starts. */
const BOOT_DELAY_MS = 10_000;

interface Watch {
  timer: ReturnType<typeof setTimeout> | null;
  source: EventSource | null;
}

/**
 * Behind a `Symbol.for` global for the same reason the controllers are: `pnpm
 * dev` re-evaluates modules on hot reload, and a second subscription to the
 * same stream is a second set of kicks nobody can cancel.
 */
const WATCH_KEY = Symbol.for("starkeep.photos.derivation.ingestWatch");

function watch(): Watch {
  const globals = globalThis as unknown as Record<symbol, Watch | undefined>;
  const existing = globals[WATCH_KEY];
  if (existing) return existing;
  const created: Watch = { timer: null, source: null };
  globals[WATCH_KEY] = created;
  return created;
}

function scheduleSweep(delayMs: number): void {
  const self = watch();
  if (self.timer) clearTimeout(self.timer);
  self.timer = setTimeout(() => {
    self.timer = null;
    if (isSweeping()) return;
    void startSweep().then((result) => {
      if (!result.ok) console.warn(`[derive] sweep did not start: ${result.error}`);
    });
  }, delayMs);
}

/**
 * Start watching. Idempotent, and a no-op anywhere the local data server is not
 * the data plane.
 *
 * The cloud is deliberately excluded. Derivation there is on-demand and bounded
 * to what a viewer is looking at, because the resize function has a third of a
 * core and thirty seconds — a whole-library sweep in that shape would time out
 * having done and discarded its work.
 */
export function startIngestWatch(dataServerUrl: string): void {
  const self = watch();
  if (self.source) return;

  // Deferred rather than immediate: the server has just started, the operator
  // is probably about to open the app, and the first thing they should get is a
  // page rather than a saturated CPU.
  scheduleSweep(BOOT_DELAY_MS);

  const source = new EventSource(`${dataServerUrl}/events`);
  self.source = source;
  source.onmessage = () => scheduleSweep(DEBOUNCE_MS);
  source.onerror = () => {
    // EventSource reconnects on its own. Logged once per failure rather than
    // torn down, because the alternative — dropping the subscription — turns a
    // transient data-server restart into "ingest never wakes derivation again"
    // for the life of this process.
    console.warn("[derive] ingest event stream error; will reconnect");
  };
}
