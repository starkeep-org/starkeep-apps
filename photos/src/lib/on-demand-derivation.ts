/**
 * Asking the server to derive a rung for a tile that is on screen.
 *
 * ## Why this exists at all
 *
 * It covers the one case no amount of queue design on the owning node fixes:
 * the originals are in the cloud, no local Photos process has ever run against
 * them, and someone opens the grid. There is nothing to wait for, so the viewer
 * asks.
 *
 * Everything else derives from that being a *last resort*:
 *
 * - **Only what is on screen.** Not the library, not a prefetch. A scroll
 *   discovers more; a page load does not commit to the whole catalogue.
 * - **Only rungs that are actually missing.** The list response says which, so
 *   this is never a guess from an absence — the tile has been told the rung is
 *   missing, told it is derivable, and told its pixel size.
 * - **Never a record the server said it cannot decode.** That request would
 *   fail every time it was made.
 * - **Once per record per session.** A record that is requested, derived and
 *   then re-enters the viewport does not get asked for again.
 *
 * ## The bound is the account's, not this machine's
 *
 * Derivation runs in a Lambda, and the account's invocation pool is small and
 * shared — one cloud page load already issues roughly a dozen invocations
 * against a default ceiling of ten. Fanning out to the size of the viewport
 * would throttle the very page-serving function rendering the page, and the
 * result presents as tiles that never arrive rather than as a capacity problem.
 *
 * So the ceiling is a declared number, and the share taken of it is a minority:
 * a third, leaving room for the page load happening at the same time. At the
 * default that is three in flight, which fills a twenty-tile viewport in about
 * two seconds at the measured per-record cost.
 *
 * The `/ 3` is a guess and is stated as one. It holds while Lambda is the
 * bottleneck; somewhere above a ceiling of roughly forty the binding constraint
 * stops being invocation slots and becomes the data server and object storage
 * on the read side, which is why this clamps rather than growing without bound.
 */

import { resolveAppApiSource } from "./data-client";
import { fetchRuntimeConfig } from "./runtime-config";

const MIN_IN_FLIGHT = 1;
const MAX_IN_FLIGHT = 12;
const SHARE_OF_POOL = 3;

export function inFlightBudget(lambdaConcurrency: number): number {
  return Math.min(
    MAX_IN_FLIGHT,
    Math.max(MIN_IN_FLIGHT, Math.floor(lambdaConcurrency / SHARE_OF_POOL)),
  );
}

interface Request {
  recordId: string;
  targetLongEdge: number;
}

const requested = new Set<string>();
const queue: Request[] = [];
let inFlight = 0;
let budget: number | null = null;

/**
 * Ask for `targetLongEdge` pixels of `recordId`, if nobody has this session.
 *
 * Fire-and-forget on purpose: the caller is a tile, and the answer it cares
 * about does not come back through this call — it arrives as a rendition the
 * next list refresh picks up. Making this awaitable would invite a tile to
 * render a spinner against a request whose completion is not the event it is
 * waiting for.
 */
export function requestDerivation(recordId: string, targetLongEdge: number): void {
  if (requested.has(recordId)) return;
  requested.add(recordId);
  queue.push({ recordId, targetLongEdge });
  void pump();
}

/** Test seam, and what a sign-out should call. */
export function resetDerivationRequests(): void {
  requested.clear();
  queue.length = 0;
  inFlight = 0;
  budget = null;
}

async function pump(): Promise<void> {
  if (budget === null) {
    const config = await fetchRuntimeConfig();
    budget = inFlightBudget(config?.lambdaConcurrency ?? 10);
  }
  while (inFlight < budget && queue.length > 0) {
    const next = queue.shift()!;
    inFlight++;
    void run(next).finally(() => {
      inFlight--;
      void pump();
    });
  }
}

async function run(request: Request): Promise<void> {
  try {
    const source = await resolveAppApiSource();
    await fetch(`${source.baseUrl}/api/resize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...source.headers },
      body: JSON.stringify({
        targetId: request.recordId,
        // The rung the tile was told it was missing, in pixels. Naming a size
        // class here would put the ladder in the client, which is the one place
        // it must never be.
        targetLongEdge: request.targetLongEdge,
      }),
    });
  } catch {
    // A failed request is a tile that keeps its placeholder. It is not retried
    // this session: whatever made it fail — a throttle, a decode the server
    // cannot do — will still be true in a few seconds, and a retry loop against
    // a shared invocation pool is how one slow tile becomes a broken page.
  }
}
