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
 * ## Leading edge, with one trailing pass
 *
 * Dropping a folder of ten thousand photos into a watched directory produces a
 * kick per file. The first kick starts a sweep immediately. Further kicks while
 * it runs collapse into one dirty bit, and worker exit consumes that bit with
 * at most one trailing discovery pass. This gives one new photo prompt service
 * without turning a bulk copy into ten thousand concurrent sweeps.
 */

import { isSweeping, startSweep, waitForSweepIdle } from "./sweep-controller";

type SweepTrigger = "server start" | "ingest kick" | "trailing ingest";

interface Watch {
  streamAbort: AbortController | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  sweepTask: Promise<void> | null;
  dirtyWhileSweeping: boolean;
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
  if (existing) {
    // Cancel and remove a debounce timer retained by a pre-change dev hot
    // reload. Fresh processes never have this property.
    const legacy = existing as Watch & { timer?: ReturnType<typeof setTimeout> | null };
    if (legacy.timer) clearTimeout(legacy.timer);
    delete legacy.timer;
    existing.sweepTask ??= null;
    existing.dirtyWhileSweeping ??= false;
    return existing;
  }
  const created: Watch = {
    streamAbort: null,
    reconnectTimer: null,
    sweepTask: null,
    dirtyWhileSweeping: false,
  };
  globals[WATCH_KEY] = created;
  return created;
}

function trackSweepTask(self: Watch, task: Promise<void>): Promise<void> {
  const tracked = task
    .catch((error: unknown) => {
      console.warn("[derive] sweep scheduling failed", error);
    })
    .finally(() => {
      if (self.sweepTask !== tracked) return;
      self.sweepTask = null;
      if (!self.dirtyWhileSweeping) return;
      self.dirtyWhileSweeping = false;
      void requestSweep("trailing ingest");
    });
  self.sweepTask = tracked;
  return tracked;
}

async function startAndObserveSweep(trigger: SweepTrigger): Promise<void> {
  const result = await startSweep();
  if (!result.ok) {
    console.warn(`[derive] ${trigger} sweep did not start: ${result.error}`);
    return;
  }
  await waitForSweepIdle();
}

function requestSweep(trigger: SweepTrigger): Promise<void> {
  const self = watch();
  if (self.sweepTask) {
    self.dirtyWhileSweeping = true;
    console.log(`[derive] ${trigger} coalesced into one trailing sweep`);
    return self.sweepTask;
  }
  if (isSweeping()) {
    self.dirtyWhileSweeping = true;
    console.log(`[derive] ${trigger} joined the running sweep; one trailing sweep retained`);
    return trackSweepTask(self, waitForSweepIdle().then(() => undefined));
  }
  return trackSweepTask(self, startAndObserveSweep(trigger));
}

/** Start the boot sweep now. Exported as the scheduling-policy test seam. */
export function startInitialSweep(): Promise<void> {
  return requestSweep("server start");
}

/** Handle one payload-free data-server event immediately. */
export function requestIngestSweep(): Promise<void> {
  return requestSweep("ingest kick");
}

/** Read the data server's payload-free SSE kicks with APIs available in Node. */
export async function consumeSseKicks(
  url: string,
  signal: AbortSignal,
  onKick: () => void,
): Promise<void> {
  const response = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`event stream failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) return;
    buffer += decoder.decode(next.value, { stream: true }).replaceAll("\r\n", "\n");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (frame.split("\n").some((line) => line.startsWith("data:"))) onKick();
    }
  }
}

function connectEventStream(dataServerUrl: string): void {
  const self = watch();
  const controller = new AbortController();
  self.streamAbort = controller;
  console.log(`[derive] connecting ingest watch to ${dataServerUrl}/events`);
  void consumeSseKicks(`${dataServerUrl}/events`, controller.signal, () => {
    console.log("[derive] ingest kick received; requesting sweep now");
    void requestIngestSweep();
  })
    .catch((error: unknown) => {
      if (!controller.signal.aborted) {
        console.warn("[derive] ingest event stream error; will reconnect", error);
      }
    })
    .finally(() => {
      if (self.streamAbort !== controller || controller.signal.aborted) return;
      self.streamAbort = null;
      self.reconnectTimer = setTimeout(() => {
        self.reconnectTimer = null;
        connectEventStream(dataServerUrl);
      }, 1_000);
    });
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
  if (self.streamAbort || self.reconnectTimer) return;

  // Start independently of the UI. This work lives in a worker thread with its
  // record concurrency capped, and measured library requests remain fast even
  // during the expensive full stage. Waiting a fixed ten seconds only made a
  // fresh install deterministically blank; waiting for a page response would
  // leave a headless library underived indefinitely.
  void startInitialSweep();

  connectEventStream(dataServerUrl);
}
