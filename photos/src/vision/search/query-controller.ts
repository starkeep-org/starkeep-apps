/**
 * Owns the query worker's lifecycle from inside the Next server.
 *
 * Like `scan-controller.ts`, the important constraint is what this file must
 * *not* do: it never imports the engine. It holds the worker bundle's path as a
 * string, so open-next's tracer walking in from the search route stops here and
 * never reaches `onnxruntime-node`.
 *
 * Two patterns are reused from the scan controller deliberately, not by copy-paste
 * habit — both are load-bearing and both were established for reasons that apply
 * identically here:
 *
 *   - **`Symbol.for` global singleton**, so a dev hot reload does not orphan a
 *     running worker with no handle to stop it.
 *   - **`Reflect.construct(WorkerCtor, …)`**, because Turbopack pattern-matches
 *     `new Worker(…)` and, given a path it cannot constant-fold, traces the entire
 *     project into the worker chunk. See `scan-controller.ts:118` for the full
 *     account; the workaround is the same and so is the failure without it.
 *
 * What is *different* from the scan controller is the lifecycle: this worker is
 * long-lived, several requests may be in flight at once, and it may exit on its
 * own at any moment because of its idle timeout. So requests are correlated by id
 * and a worker that has gone away is simply restarted on the next call, rather
 * than being an error state anyone has to see.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { decodeEmbedding } from "../embeddings";
import { searchModelStatus, SEARCH_TEXT_MODEL, SEARCH_TOKENIZER } from "../models";
import { modelPath } from "../paths";
import type { QueryReply, QueryRequest, UnidentifiedRequest } from "./query-protocol";

/** Built by `pnpm vision:build-worker` alongside the scan worker. */
export function queryWorkerBundlePath(): string {
  // Built from literals so Turbopack can constant-fold it, and deliberately with
  // no env override — see `scan-controller.ts` for what an unfoldable path costs.
  return join(process.cwd(), ".vision", "query-worker.mjs");
}

interface Pending {
  resolve(reply: QueryReply): void;
  reject(error: Error): void;
}

interface Controller {
  worker: Worker | null;
  nextId: number;
  pending: Map<number, Pending>;
}

const CONTROLLER_KEY = Symbol.for("starkeep.photos.vision.queryController");

function controller(): Controller {
  const globals = globalThis as unknown as Record<symbol, Controller | undefined>;
  let existing = globals[CONTROLLER_KEY];
  if (!existing) {
    existing = { worker: null, nextId: 1, pending: new Map() };
    globals[CONTROLLER_KEY] = existing;
  }
  return existing;
}

export class SearchUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SearchUnavailableError";
  }
}

async function ensureWorker(self: Controller): Promise<Worker> {
  if (self.worker) return self.worker;

  const models = searchModelStatus();
  if (!models.installed) {
    throw new SearchUnavailableError(
      `the search models are not installed (missing ${models.missing.join(", ")}) — ` +
        `run \`pnpm vision:fetch-models --search\``,
      409,
    );
  }

  const bundle = queryWorkerBundlePath();
  if (!existsSync(bundle)) {
    throw new SearchUnavailableError(
      `the query worker is not built at ${bundle} — run \`pnpm vision:build-worker\``,
      500,
    );
  }

  const { Worker: WorkerCtor } = await import("node:worker_threads");
  const worker = Reflect.construct(WorkerCtor, [
    bundle,
    {
      workerData: {
        textPath: modelPath(SEARCH_TEXT_MODEL.fileName),
        tokenizerPath: modelPath(SEARCH_TOKENIZER.fileName),
      },
    },
  ]) as Worker;

  worker.on("message", (reply: QueryReply) => {
    const pending = self.pending.get(reply.id);
    if (!pending) return;
    self.pending.delete(reply.id);
    pending.resolve(reply);
  });

  // A worker that dies takes every in-flight request with it. Rejecting them
  // explicitly is what keeps a search from hanging forever on a promise nothing
  // will ever settle.
  const fail = (error: Error) => {
    self.worker = null;
    for (const [, pending] of self.pending) pending.reject(error);
    self.pending.clear();
  };
  worker.on("error", (err: unknown) => {
    fail(err instanceof Error ? err : new Error(String(err)));
  });
  worker.on("exit", () => {
    // Usually the idle timeout, which is not an error — but any request still
    // outstanding at that point genuinely failed.
    fail(new Error("the query worker exited"));
  });

  self.worker = worker;
  return worker;
}

async function send(request: UnidentifiedRequest): Promise<QueryReply> {
  const self = controller();
  const worker = await ensureWorker(self);
  const id = self.nextId++;

  return new Promise<QueryReply>((resolve, reject) => {
    self.pending.set(id, { resolve, reject });
    worker.postMessage({ ...request, id } as QueryRequest);
  });
}

/**
 * Embed one or more query strings via the worker.
 *
 * Retries once on a dead worker, because the idle timeout means "the worker went
 * away" is an ordinary occurrence rather than a fault: a search arriving just as
 * the timer fires would otherwise fail for no reason the user could act on.
 */
export async function embedQueries(queries: readonly string[]): Promise<Float32Array[]> {
  if (queries.length === 0) return [];
  let reply: QueryReply;
  try {
    reply = await send({ type: "embed", queries: [...queries] });
  } catch (err) {
    if (err instanceof SearchUnavailableError) throw err;
    reply = await send({ type: "embed", queries: [...queries] });
  }
  if (reply.type === "error") throw new Error(reply.message);
  if (reply.type !== "embedded") throw new Error(`unexpected reply ${reply.type}`);
  return reply.vectors.map(decodeEmbedding);
}

/**
 * Tell the worker a scan changed the embeddings (§6's index invalidation).
 *
 * Best-effort by design: if there is no worker, there is nothing stale to
 * invalidate, and starting one just to tell it that would be backwards.
 */
export async function invalidateQueryWorker(): Promise<void> {
  const self = controller();
  if (!self.worker) return;
  try {
    await send({ type: "invalidate" });
  } catch {
    // A worker that died on the way is invalidated in the strongest sense.
  }
}

export function isQueryWorkerRunning(): boolean {
  return controller().worker !== null;
}

/** Stop the worker now. For tests, and for a Settings action that frees the memory. */
export async function stopQueryWorker(): Promise<void> {
  const self = controller();
  const worker = self.worker;
  self.worker = null;
  if (worker) await worker.terminate();
}
