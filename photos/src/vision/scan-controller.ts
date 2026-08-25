/**
 * Owns the scan worker's lifecycle from inside the Next server.
 *
 * The important constraint is what this file must *not* do: it never imports the
 * engine. It holds the worker bundle's path as a string and hands it to
 * `new Worker(...)`, so open-next's dependency tracer walking in from a route
 * stops here and never reaches `onnxruntime-node`. See
 * `__tests__/vision-bundle-isolation.test.ts`.
 *
 * Liveness lives here, not in `scan-state.json`. A process killed mid-pass
 * leaves `running: true` on disk forever; the controller knows whether it
 * actually has a worker, and reconciles the file the first time it is asked.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { readVisionConfig } from "./config";
import { FACE_DETECTOR_MODEL, FACE_EMBEDDER_MODEL, faceModelStatus } from "./models";
import { modelPath } from "./paths";
import { readScanState, writeScanState } from "./scan-state";
import type { ScanState } from "./types";
import type { ScanCommand, ScanEvent } from "./worker-protocol";

/**
 * Where `pnpm vision:build-worker` puts the worker — a build artefact rather
 * than the `.ts` source, because `worker_threads` needs JavaScript, and
 * bundling it is also what guarantees the engine has exactly one entry point.
 *
 * The path is built from literals so Turbopack can constant-fold it, and there
 * is deliberately **no env override**. Given a path it cannot fold, Turbopack
 * concludes the module reads arbitrary files and traces the *entire project*
 * into the route's bundle — `scripts/`, `e2e/`, and through them esbuild and
 * vite. An override knob is not worth that, and nothing needs one: the path is
 * fixed and this only ever runs in one place.
 *
 * It is cwd-relative because Photos is launched by its manifest's `localRun`
 * (`pnpm dev`) in the app directory, and a remote target is refused long before
 * any of this is reached.
 */
export const WORKER_BUNDLE = ".vision/scan-worker.mjs";

export function workerBundlePath(): string {
  return join(process.cwd(), ".vision", "scan-worker.mjs");
}

interface Controller {
  worker: Worker | null;
  state: ScanState;
  reconciled: boolean;
}

/**
 * A module-level singleton would be re-created on every hot reload in dev,
 * orphaning a running worker with no handle to stop it. The global survives the
 * module instance.
 */
const CONTROLLER_KEY = Symbol.for("starkeep.photos.vision.scanController");

function controller(): Controller {
  const globals = globalThis as unknown as Record<symbol, Controller | undefined>;
  let existing = globals[CONTROLLER_KEY];
  if (!existing) {
    existing = { worker: null, state: readScanState(), reconciled: false };
    globals[CONTROLLER_KEY] = existing;
  }
  if (!existing.reconciled) {
    existing.reconciled = true;
    // No worker but the file says running → the pass died with its process.
    if (existing.worker === null && existing.state.running) {
      existing.state = {
        ...existing.state,
        running: false,
        finishedAt: new Date().toISOString(),
        error: "the scan was interrupted — the app restarted while it was running",
      };
      writeScanState(existing.state);
    }
  }
  return existing;
}

export type StartResult =
  | { ok: true; state: ScanState }
  | { ok: false; status: number; error: string };

export async function startScan(): Promise<StartResult> {
  const self = controller();
  if (self.worker) return { ok: false, status: 409, error: "a scan is already running" };

  // Derivation has priority, and the reason is dependency rather than
  // preference: this scan reads `image-medium`, so a library whose renditions
  // are still being produced is a library this scan would walk past. Both are
  // CPU-bound sweeps over everything and they now share a process, so running
  // them at once makes the machine unusable and both of them slower.
  //
  // Imported lazily to keep the derivation module out of this one's static
  // graph, which is the same isolation rule this file exists to hold.
  const { isSweeping } = await import("../derivation/sweep-controller");
  if (isSweeping()) {
    return {
      ok: false,
      status: 409,
      error:
        "derivation is running — it produces the size this scan reads, so it goes first. " +
        "Stop it first if you want to scan against what is already derived.",
    };
  }

  const config = readVisionConfig();
  if (!config.faces.enabled) {
    return { ok: false, status: 409, error: "face detection is off — enable it in Settings first" };
  }

  const models = faceModelStatus();
  if (!models.installed) {
    return {
      ok: false,
      status: 409,
      error: `face models are not installed (missing ${models.missing.join(", ")}) — run \`pnpm vision:fetch-models\``,
    };
  }

  const bundle = workerBundlePath();
  if (!existsSync(bundle)) {
    return {
      ok: false,
      status: 500,
      error: `the vision worker is not built at ${bundle} — run \`pnpm vision:build-worker\``,
    };
  }

  // Imported here, not at module scope, so the static import graph a bundler
  // walks contains no `worker_threads` reference from a route either.
  const { Worker: WorkerCtor } = await import("node:worker_threads");

  // Constructed reflectively, and this is load-bearing rather than clever.
  // Turbopack pattern-matches `new Worker(…)` and emits a worker chunk for it.
  // Given a computed path it cannot tell what belongs in that chunk, so it
  // traces the whole project into it — `scripts/`, `e2e/`, and through them
  // esbuild and vite — and the build dies on a README it cannot classify. A
  // `turbopackIgnore` comment does not suppress it; removing the `new`
  // expression does. The worker is our own build artefact
  // (`pnpm vision:build-worker`) and is meant to be loaded, not bundled.
  const worker = Reflect.construct(WorkerCtor, [bundle]) as Worker;
  self.worker = worker;

  worker.on("message", (event: ScanEvent) => {
    if (event.type === "failed") {
      self.state = { ...readScanState(), running: false, error: event.message };
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
    writeScanState(self.state);
  });
  worker.on("exit", () => {
    self.worker = null;
    // The worker's last write is authoritative — re-read rather than trusting
    // whatever message happened to arrive last.
    self.state = readScanState();
  });

  const command: ScanCommand = {
    type: "start",
    config,
    detectorPath: modelPath(FACE_DETECTOR_MODEL.fileName),
    embedderPath: modelPath(FACE_EMBEDDER_MODEL.fileName),
  };
  worker.postMessage(command);

  self.state = { ...self.state, running: true, error: null };
  return { ok: true, state: self.state };
}

/**
 * Ask the pass to stop between images and let the worker exit on its own.
 *
 * Cooperative rather than `terminate()`: the worker owns the sidecar writes and
 * the end-of-pass clustering fold, and killing it mid-write is how a store ends
 * up with a truncated sidecar that later reads as "processed, no faces".
 */
export function stopScan(): ScanState {
  const self = controller();
  const stop: ScanCommand = { type: "stop" };
  self.worker?.postMessage(stop);
  return self.state;
}

export function isScanning(): boolean {
  return controller().worker !== null;
}

export function currentScanState(): ScanState {
  const self = controller();
  // A worker that has exited can't still be running, whatever the last message
  // said — the handle is the truth.
  if (!self.worker && self.state.running) {
    self.state = { ...readScanState(), running: false };
  }
  return self.state;
}
