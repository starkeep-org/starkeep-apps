/**
 * The scan worker: one `worker_threads` thread that walks the library, runs the
 * enabled vision tasks, and writes sidecars.
 *
 * ⚠ **Never import this from `app/`.** It is the entry point that pulls in
 * `face-engine.ts` and therefore `onnxruntime-node`. The scan controller starts
 * it by absolute path (`.vision/scan-worker.mjs`, produced by
 * `pnpm vision:build-worker`), which is what keeps 270 MB of ORT out of
 * open-next's dependency trace.
 *
 * A worker rather than the request thread because a first pass over ~10k photos
 * is 45–60 minutes of CPU: even with ORT's off-thread `run()`, the decode,
 * letterbox, warp, and tensor packing around it are synchronous JavaScript, and
 * that is enough to make the grid stutter for the whole scan.
 */

import { parentPort } from "node:worker_threads";
import { loadAppCredentials, signedFetch, type AppCredentials } from "@starkeep/app-client";
import { assignUnclusteredFaces, reconcilePeopleToStore } from "../clustering";
import { emptyScanState, type ScanState, type VisionConfig } from "../types";
import { readScanState, writeScanState } from "../scan-state";
import { listOriginals } from "../scan-set";
import { reapOrphanSidecars } from "../sidecars";
import { PROGRESS_INTERVAL_MS, type ScanCommand, type ScanEvent } from "../worker-protocol";
import { FaceEngine } from "./face-engine";
import { faceTask, type VisionTask } from "./tasks";

/** Cancellation is cooperative: the loop checks between images. */
let stopRequested = false;
let running = false;

function post(event: ScanEvent): void {
  parentPort?.postMessage(event);
}

async function fetchImageBytes(creds: AppCredentials, recordId: string): Promise<Uint8Array> {
  const urlRes = await signedFetch(creds, `/data/records/${recordId}/file-url`);
  if (!urlRes.ok) throw new Error(`file-url failed: ${urlRes.status}`);
  const { url } = (await urlRes.json()) as { url: string };
  // A self-signed token URL — no HMAC needed, same as the resize route.
  const fileRes = await fetch(url);
  if (!fileRes.ok) throw new Error(`file fetch failed: ${fileRes.status}`);
  return new Uint8Array(await fileRes.arrayBuffer());
}

async function runScan(command: Extract<ScanCommand, { type: "start" }>): Promise<void> {
  const config: VisionConfig = command.config;
  const state: ScanState = {
    ...emptyScanState(),
    running: true,
    startedAt: new Date().toISOString(),
  };
  writeScanState(state);
  post({ type: "progress", state });

  const creds = await loadAppCredentials("photos");
  if (!creds) throw new Error("photos has not been installed locally — run install from admin-web");

  const engine = await FaceEngine.create({
    detectorPath: command.detectorPath,
    embedderPath: command.embedderPath,
  });

  const tasks: VisionTask[] = [faceTask(engine)].filter((task) => task.enabled(config));
  if (tasks.length === 0) {
    // Nothing enabled is a finished pass over nothing, not an error — it is what
    // "start a scan with faces off" means.
    await engine.dispose();
    finish(state, null);
    return;
  }

  let lastProgress = 0;
  try {
    const recordIds = await listOriginals((path) => signedFetch(creds, path));
    state.eligible = recordIds.length;

    // Reconcile the store against the library before anything reads it — the
    // skip check below, the counts, and the clustering fold at the end all fold
    // over every sidecar on disk, so an orphan is not merely stale, it votes.
    //
    // Here because this is the only place holding a listing that is both
    // complete (paged to exhaustion) and authoritative; the status route polls
    // and has no business making a network call to get one.
    //
    // Empty is the exception. An empty library really does orphan every sidecar,
    // but it is also what a scan started against a data server mid-reinstall
    // sees, and the two are indistinguishable from here. Reaping then would
    // discard the store — and with it the face→person assignments that make the
    // names in `people.json` mean anything — to save a pass that has no work to
    // do either way. Skipping costs nothing: the next non-empty scan reaps.
    if (recordIds.length > 0) {
      const reaped = reapOrphanSidecars(new Set(recordIds));
      if (reaped.length > 0) {
        // `people.json` caches sizes and centroids over faces that just went
        // away, and nothing downstream recomputes them — see
        // `reconcilePeopleToStore`.
        const dropped = reconcilePeopleToStore();
        console.warn(
          `[vision] reaped ${reaped.length} sidecar(s) for records no longer present` +
            (dropped > 0 ? `; dropped ${dropped} now-empty person cluster(s)` : ""),
        );
      }
    }

    for (const recordId of recordIds) {
      if (stopRequested) break;

      const pending = tasks.filter((task) => !task.isProcessed(recordId));
      if (pending.length === 0) {
        state.skipped++;
      } else {
        try {
          const bytes = await fetchImageBytes(creds, recordId);
          for (const task of pending) {
            await task.run(recordId, bytes);
            state.processed[task.id] = (state.processed[task.id] ?? 0) + 1;
          }
        } catch (err) {
          // One unreadable or undecodable photo must not end a 10k-image pass.
          // It is counted, and retried on the next pass because no sidecar was
          // written for it.
          state.failed++;
          console.warn(`[vision] ${recordId} failed:`, err);
        }
      }

      if (Date.now() - lastProgress > PROGRESS_INTERVAL_MS) {
        lastProgress = Date.now();
        writeScanState(state);
        post({ type: "progress", state });
      }
    }

    // Clustering is a fold over the whole store, so it runs once at the end —
    // including after a stop, so the faces that *were* found are usable.
    if (config.faces.enabled) assignUnclusteredFaces(config.faces.threshold);
    finish(state, null);
  } finally {
    await engine.dispose();
  }
}

function finish(state: ScanState, error: string | null): void {
  state.running = false;
  state.finishedAt = new Date().toISOString();
  state.error = error;
  writeScanState(state);
  post({ type: "finished", state });
  retire();
}

/**
 * End the thread once the pass is over.
 *
 * Not an optimisation — a correctness fix. The host equates "I hold a worker"
 * with "a scan is running", so a worker that idles after finishing leaves the
 * status endpoint reporting a running scan forever and every subsequent start
 * rejected as a duplicate. There is nothing to keep alive for either: the engine
 * is disposed at the end of a pass, so the next one reloads its sessions
 * regardless.
 *
 * `close()` rather than `process.exit()` so the messages already posted above
 * are still delivered.
 */
function retire(): void {
  parentPort?.close();
}

parentPort?.on("message", (command: ScanCommand) => {
  if (command.type === "stop") {
    stopRequested = true;
    return;
  }
  if (running) return;
  running = true;
  stopRequested = false;
  void runScan(command)
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      const state = readScanState();
      state.running = false;
      state.finishedAt = new Date().toISOString();
      state.error = message;
      writeScanState(state);
      post({ type: "failed", message });
      retire();
    })
    .finally(() => {
      running = false;
    });
});
