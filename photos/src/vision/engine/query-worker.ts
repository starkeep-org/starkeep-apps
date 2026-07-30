/**
 * The query worker: one long-lived `worker_threads` thread holding the SigLIP text
 * tower, so a search can embed a free-form query without `onnxruntime-node` ever
 * becoming reachable from `app/` (plan §6).
 *
 * ⚠ **Never import this from `app/`.** It is the second entry point that pulls in
 * ORT, built to `.vision/query-worker.mjs` by `pnpm vision:build-worker`.
 *
 * **Its lifecycle is the opposite of the scan worker's**, which is the whole
 * reason it is a separate worker rather than a message on the existing one:
 *
 *   - The scan worker `retire()`s itself when a pass finishes, deliberately,
 *     because the controller equates "holds a worker" with "a scan is running".
 *     Reusing it for search would make every search look like a running scan.
 *   - This one stays alive across requests, because loading the text tower is the
 *     expensive part and a query is interactive.
 *   - But it must not stay alive *forever*: a background tab would otherwise hold
 *     the tower resident indefinitely. So it exits itself after
 *     `QUERY_WORKER_IDLE_MS` with no work, and the host transparently starts a new
 *     one on the next search.
 *
 * It holds only the text tower. The **index** is deliberately re-read on the host
 * side rather than cached here: reading it is one `readFileSync` plus a
 * `Float32Array` copy, the scan rewrites it out from under us, and caching it here
 * would mean a second invalidation path for no measurable gain.
 */

import { parentPort } from "node:worker_threads";
import { encodeEmbedding } from "../embeddings";
import {
  QUERY_WORKER_IDLE_MS,
  type QueryReply,
  type QueryRequest,
} from "../search/query-protocol";
import { TextEngine } from "./siglip-text";

interface Config {
  textPath: string;
  tokenizerPath: string;
}

/**
 * Passed via `workerData` rather than a start message, so the very first request
 * does not need a handshake — the host already knows the paths and the worker has
 * no path policy of its own, exactly as the scan command does it.
 */
const config = (await import("node:worker_threads")).workerData as Config;

let engine: TextEngine | null = null;
let loading: Promise<TextEngine> | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function post(reply: QueryReply): void {
  parentPort?.postMessage(reply);
}

/**
 * Load on first use, once, even if several requests arrive together.
 *
 * The `loading` promise is what makes that true: without it, two searches racing
 * the first request would each construct a session and one would leak.
 */
function engineReady(): Promise<TextEngine> {
  if (engine) return Promise.resolve(engine);
  if (!loading) {
    loading = TextEngine.create(config).then((created) => {
      engine = created;
      loading = null;
      return created;
    });
  }
  return loading;
}

/**
 * Restart the idle countdown.
 *
 * `unref()` so a pending timer is not itself a reason for the thread to stay
 * alive — without it the worker would linger for the full interval after the host
 * has already given up on it.
 */
function touch(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(retire, QUERY_WORKER_IDLE_MS);
  idleTimer.unref();
}

async function retire(): Promise<void> {
  const held = engine;
  engine = null;
  await held?.dispose();
  // `close()` rather than `process.exit()`, so any reply already posted is still
  // delivered — same reasoning as the scan worker's retirement.
  parentPort?.close();
}

parentPort?.on("message", (request: QueryRequest) => {
  touch();
  void (async () => {
    try {
      switch (request.type) {
        case "embed": {
          const ready = await engineReady();
          const vectors = await ready.embedAll(request.queries);
          post({ type: "embedded", id: request.id, vectors: vectors.map(encodeEmbedding) });
          return;
        }
        case "invalidate": {
          // Nothing cached here today (the host re-reads the index), so this is an
          // acknowledged no-op. It exists because the *host* has to have somewhere
          // to send end-of-scan invalidation, and adding the message later would
          // mean a protocol change rather than a one-line change here.
          post({ type: "invalidated", id: request.id });
          return;
        }
      }
    } catch (err) {
      post({
        type: "error",
        id: request.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});

// Start the clock immediately: a worker started and then never asked anything
// should not outlive the request that started it.
touch();
