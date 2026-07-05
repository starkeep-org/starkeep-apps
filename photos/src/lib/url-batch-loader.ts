/**
 * Coalesces individual signed-URL requests into batches. Thumbnails entering
 * the viewport each ask for one id; instead of one file-url call per photo
 * (the fan-out that saturated the Lambda concurrency pool), ids are collected
 * for a short window and resolved with a single batch call.
 *
 * Failure semantics: a failed batch (or an id the server omitted) is simply
 * released, so a later request() for the same id schedules it again — mirrors
 * the fire-and-forget retry the per-id cache did before.
 */
export interface UrlBatchLoader {
  /** Schedule an id for the next flush. Idempotent while pending/in-flight. */
  request(id: string): void;
  /** Cancel any pending flush and drop late results. */
  dispose(): void;
}

export function createUrlBatchLoader(options: {
  loadBatch: (ids: string[]) => Promise<Map<string, string>>;
  onLoaded: (urls: Map<string, string>) => void;
  flushDelayMs?: number;
}): UrlBatchLoader {
  const flushDelayMs = options.flushDelayMs ?? 50;
  const pending = new Set<string>();
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  async function flush(): Promise<void> {
    timer = null;
    const batch = [...pending];
    pending.clear();
    if (batch.length === 0) return;
    for (const id of batch) inFlight.add(id);
    try {
      const urls = await options.loadBatch(batch);
      if (!disposed && urls.size > 0) options.onLoaded(urls);
    } catch (err) {
      console.warn("[url-batch-loader] batch load failed:", err);
    } finally {
      // Loaded ids live in the caller's cache now; failed/omitted ids become
      // requestable again.
      for (const id of batch) inFlight.delete(id);
    }
  }

  return {
    request(id: string): void {
      if (disposed || pending.has(id) || inFlight.has(id)) return;
      pending.add(id);
      if (timer === null) {
        timer = setTimeout(() => void flush(), flushDelayMs);
      }
    },
    dispose(): void {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending.clear();
    },
  };
}
