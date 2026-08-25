/**
 * Owns the derivation worker's lifecycle from inside the Next server.
 *
 * The important constraint is what this file must *not* do: it never imports
 * the worker. It holds the worker bundle's path as a string and hands it to
 * `new Worker(...)`, so open-next's dependency tracer walking in from a route
 * stops here and never reaches sharp. Exactly the shape
 * `vision/scan-controller.ts` uses, for exactly the same reason.
 *
 * Liveness lives here, not in `sweep-state.json`. A process killed mid-sweep
 * leaves `running: true` on disk forever; the controller knows whether it
 * actually has a worker, and reconciles the file the first time it is asked.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { isScanning, stopScan } from "../vision/scan-controller";
import { readSweepState, writeSweepState } from "./sweep-state";
import type { SweepState } from "./types";
import type { SweepCommand, SweepEvent } from "./worker-protocol";

/**
 * Where `pnpm derive:build-worker` puts the worker — a build artefact rather
 * than the `.ts` source, because `worker_threads` needs JavaScript.
 *
 * Built from literals so Turbopack can constant-fold it, and deliberately with
 * **no env override**: given a path it cannot fold, Turbopack concludes the
 * module reads arbitrary files and traces the entire project into the route's
 * bundle. The path is fixed and nothing needs one.
 */
export const WORKER_BUNDLE = ".derivation/derive-worker.mjs";

export function workerBundlePath(): string {
  return join(process.cwd(), ".derivation", "derive-worker.mjs");
}

/**
 * How many records are derived at once.
 *
 * Two, and the measurement is why it is not more: one, two, three, four and
 * seven concurrent records came in at 35.8, 29.7, 28.7, 28.7 and 30.3 seconds.
 * The work is CPU-bound and sharp already threads across cores, so past two
 * this buys nothing and starts costing.
 *
 * What the number is actually protecting is not throughput. It is the
 * single-threaded data server serving tiles to whoever has the grid open, and
 * the operator's laptop being usable while this runs. The worker caps sharp's
 * own thread pool for the same reason.
 */
const RECORD_CONCURRENCY = 2;

interface Controller {
  worker: Worker | null;
  state: SweepState;
  reconciled: boolean;
}

/**
 * A module-level singleton would be re-created on every hot reload in dev,
 * orphaning a running worker with no handle to stop it. The global survives the
 * module instance.
 */
const CONTROLLER_KEY = Symbol.for("starkeep.photos.derivation.sweepController");

function controller(): Controller {
  const globals = globalThis as unknown as Record<symbol, Controller | undefined>;
  let existing = globals[CONTROLLER_KEY];
  if (!existing) {
    existing = { worker: null, state: readSweepState(), reconciled: false };
    globals[CONTROLLER_KEY] = existing;
  }
  if (!existing.reconciled) {
    existing.reconciled = true;
    // No worker but the file says running → the sweep died with its process.
    // The cursor is kept: that is the whole point of writing it.
    if (existing.worker === null && existing.state.running) {
      existing.state = {
        ...existing.state,
        running: false,
        finishedAt: new Date().toISOString(),
        error: "the sweep was interrupted — the app restarted while it was running",
      };
      writeSweepState(existing.state);
    }
  }
  return existing;
}

export type StartResult =
  | { ok: true; state: SweepState }
  | { ok: false; status: number; error: string };

/**
 * Start a sweep, resuming wherever the last one stopped.
 *
 * **Derivation goes first when the vision scan is also running.** Both are
 * CPU-bound, both walk the whole library, and they now live in one process, so
 * running them at full width concurrently makes the laptop unusable and makes
 * both slower. The tie is broken by dependency rather than by preference: the
 * vision scan reads `image-medium`, so it depends on derivation having produced
 * it, and a scan that runs first has nothing to read for exactly the records
 * that need it most.
 *
 * The scan is asked to stop rather than terminated. It is resumable by design —
 * its results are sidecars on disk, and a stopped pass still runs its clustering
 * fold over what it found — so this costs it nothing but the image it is on.
 */
export async function startSweep(): Promise<StartResult> {
  const self = controller();
  if (self.worker) return { ok: false, status: 409, error: "a sweep is already running" };

  const bundle = workerBundlePath();
  if (!existsSync(bundle)) {
    return {
      ok: false,
      status: 500,
      error: `the derivation worker is not built at ${bundle} — run \`pnpm derive:build-worker\``,
    };
  }

  if (isScanning()) {
    console.log("[derive] asking the vision scan to yield — derivation produces the rung it reads");
    stopScan();
  }

  // Imported here, not at module scope, so the static import graph a bundler
  // walks contains no `worker_threads` reference from a route either.
  const { Worker: WorkerCtor } = await import("node:worker_threads");

  // Constructed reflectively, which is load-bearing rather than clever:
  // Turbopack pattern-matches `new Worker(…)` and emits a worker chunk for it,
  // and given a computed path it cannot tell what belongs in that chunk, so it
  // traces the whole project in. The worker is our own build artefact and is
  // meant to be loaded, not bundled.
  const worker = Reflect.construct(WorkerCtor, [bundle]) as Worker;
  self.worker = worker;

  worker.on("message", (event: SweepEvent) => {
    if (event.type === "failed") {
      self.state = { ...readSweepState(), running: false, error: event.message };
      return;
    }
    self.state = event.state;
  });
  worker.on("error", (err: unknown) => {
    self.state = {
      ...self.state,
      running: false,
      finishedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
    writeSweepState(self.state);
  });
  worker.on("exit", () => {
    self.worker = null;
    // The worker's last write is authoritative — re-read rather than trusting
    // whichever message happened to arrive last.
    self.state = readSweepState();
  });

  const resumeFrom = readSweepState();
  const command: SweepCommand = {
    type: "start",
    resume: { stage: resumeFrom.stage, cursor: resumeFrom.cursor },
    concurrency: RECORD_CONCURRENCY,
  };
  worker.postMessage(command);

  self.state = { ...self.state, running: true, error: null };
  return { ok: true, state: self.state };
}

/**
 * Ask the sweep to stop between records and let the worker exit on its own.
 *
 * Cooperative rather than `terminate()`: the worker is mid-publish for one or
 * two records, and killing it there leaves a rendition uploaded but not
 * registered — storage nothing will ever read, and a record that still looks
 * underived.
 */
export function stopSweep(): SweepState {
  const self = controller();
  const stop: SweepCommand = { type: "stop" };
  self.worker?.postMessage(stop);
  return self.state;
}

export function isSweeping(): boolean {
  return controller().worker !== null;
}

export function currentSweepState(): SweepState {
  const self = controller();
  // A worker that has exited cannot still be running, whatever the last
  // message said — the handle is the truth.
  if (!self.worker && self.state.running) {
    self.state = { ...readSweepState(), running: false };
  }
  return self.state;
}
