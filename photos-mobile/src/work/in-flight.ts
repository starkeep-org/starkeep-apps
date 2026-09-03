/**
 * One request per key at a time, and only so many at once.
 *
 * ## What this is for
 *
 * A grid that fetches renditions has two ways to embarrass itself, and they are
 * different problems with different answers.
 *
 * The first is **duplication**. The same record's rung is asked for by the tile
 * that scrolled past it, by the reload that followed an import, and by the
 * viewer somebody opened it in — three requests for one file, two of which are
 * pure waste and all three of which land in the same place. Keying by
 * `${recordId}:${target}` collapses them into one.
 *
 * The second is **volume**. Even deduplicated, a screen of tiles with nothing
 * resident is thirty requests fired in one frame. The cloud side of this is a
 * Lambda behind a concurrency cap that a single page load can already exhaust —
 * `on-demand-derivation.ts` makes the same argument about the same ceiling — so
 * the answer is the same one: take a share of the pool, not the pool.
 *
 * ## Why a module rather than a ref in the hook
 *
 * Because it is decidable and the hook is not. "Two calls for one key produce
 * one request" and "the fourth call waits" are assertions about a rule, and this
 * app's convention is that a rule runs in Node against fakes. A `Map` inside a
 * `useCallback` is the same logic somewhere nothing can reach it.
 *
 * ## What it deliberately does not do
 *
 * It does not cache. A completed request is forgotten the moment it settles, so
 * a later call for the same key runs again. That is right: the reason to ask
 * twice is that something changed — the blob was evicted, the first attempt
 * failed, the record was re-derived — and a memo would answer all three from a
 * result that is no longer true. Deduplication is about *concurrent* callers,
 * and nothing else.
 *
 * It also does not prioritise. The queue is first-in, first-out, so a viewer's
 * request can sit behind three tiles'. That is worth knowing about and is not
 * worth fixing yet: the cap is three, the tiles ahead are small rungs, and a
 * priority queue is a second ordering to reason about. If the viewer is ever
 * observed waiting, this is the file to change.
 */

/** A keyed single-flight with a ceiling on how many run at once. */
export interface InFlight {
  /**
   * Run `work` under `key`, or join the call already running under it.
   *
   * Every caller for one key gets the same promise, so they succeed and fail
   * together. A rejection propagates to all of them rather than to whichever
   * arrived first, which is what stops a shared failure from looking like a
   * failure of one tile.
   */
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
  /** How many keys are running or waiting. Diagnostics, and the tests. */
  readonly pending: number;
  /** How many are actually running. */
  readonly running: number;
}

/**
 * How many rendition fetches may be in flight at once.
 *
 * **Three, and the number is a share of a pool rather than a guess about this
 * device.** The ceiling that matters is not the phone's — a phone can hold
 * thirty sockets open without noticing — it is the cloud's Lambda concurrency,
 * which one page load of the web app can already exhaust. Taking three of it
 * leaves the rest for everything else this node and every other node is doing.
 *
 * It is also what keeps a scroll from starving the thing somebody is looking at.
 * With no cap, a flick through a cold library queues a request per tile, and the
 * photograph opened at the end of it is the last one served.
 */
export const RENDITION_FETCH_CONCURRENCY = 3;

/** A single-flight admitting at most `limit` concurrent calls. */
export function createInFlight(options: { readonly limit: number }): InFlight {
  const joined = new Map<string, Promise<unknown>>();
  const waiting: Array<() => void> = [];
  let running = 0;

  /** Take a slot, waiting for one if the limit is reached. */
  function acquire(): Promise<void> {
    if (running < options.limit) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiting.push(resolve));
  }

  /**
   * Give a slot back, handing it straight to whoever is next.
   *
   * The slot is passed rather than released-and-reacquired, so a waiter cannot
   * lose the slot it was woken for to a call that arrived in the same tick.
   */
  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }

  return {
    run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const existing = joined.get(key);
      if (existing) return existing as Promise<T>;

      const promise = (async () => {
        await acquire();
        try {
          return await work();
        } finally {
          // Both, and in this order. Forgetting the key first means a caller
          // arriving during the release starts a fresh request rather than
          // joining one that has already settled.
          joined.delete(key);
          release();
        }
      })();

      joined.set(key, promise);
      // A rejection with no handler attached yet is an unhandled rejection in
      // some runtimes, and this promise is stored before any caller has had the
      // chance to attach one. The `catch` exists only to mark it handled — the
      // real rejection still reaches everyone who awaited the value above.
      promise.catch(() => {});
      return promise;
    },
    get pending() {
      return joined.size;
    },
    get running() {
      return running;
    },
  };
}
