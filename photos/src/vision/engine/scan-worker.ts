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
import { assignUnclusteredFaces } from "../clustering";
import { emptyScanState, type ScanState, type VisionConfig } from "../types";
import { readScanState, writeScanState } from "../scan-state";
import { PROGRESS_INTERVAL_MS, type ScanCommand, type ScanEvent } from "../worker-protocol";
import { FaceEngine } from "./face-engine";
import { faceTask, type VisionTask } from "./tasks";

/** Records per listing page. A short page never means the end — see below. */
const RECORDS_PER_PAGE = 200;

interface ListedRecord {
  id: string;
  parent_id: string | null;
  labels?: Array<{ app_id: string; key: string; value: string }>;
}

/** Cancellation is cooperative: the loop checks between images. */
let stopRequested = false;
let running = false;

function post(event: ScanEvent): void {
  parentPort?.postMessage(event);
}

/**
 * The scan set: originals only.
 *
 * `derivation === "original"` in the plan's terms, read off Photos' own labels
 * rather than `parent_id` — a crop has a parent too. Thumbnails are excluded
 * because they are 400 px re-encodings of images already in the set, and crops
 * because a crop's faces are its parent's faces at an offset. Both would be
 * double work whose results duplicate an original's.
 */
function isOriginal(record: ListedRecord): boolean {
  if (record.parent_id !== null) return false;
  return !(record.labels ?? []).some(
    (l) => l.app_id === "photos" && (l.key === "thumbnail" || l.key === "crop"),
  );
}

async function listOriginals(creds: AppCredentials): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const res = await signedFetch(
      creds,
      `/data/records?include=labels&limit=${RECORDS_PER_PAGE}${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    );
    if (!res.ok) throw new Error(`list records failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      records: ListedRecord[];
      nextCursor?: string | null;
    };
    for (const record of body.records) {
      if (isOriginal(record)) ids.push(record.id);
    }
    // Page to exhaustion. A short page does NOT mean the end — only an exhausted
    // cursor does. Stopping on the first short page silently skips images.
    //
    // `?? null` is load-bearing: the data server's last page omits `nextCursor`
    // entirely rather than sending `null` (the adapter's own field is optional,
    // and `JSON.stringify` drops `undefined`). Comparing the raw value against
    // `null` therefore never terminates — a hang, not a wrong answer, and one
    // that only appears against a real server.
    cursor = body.nextCursor ?? null;
  } while (cursor !== null);
  return ids;
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
    const recordIds = await listOriginals(creds);
    state.eligible = recordIds.length;

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
