import { useEffect, useRef, useCallback } from "react";
import type { AppImage } from "@/photos-lib/client";
import { fetchRuntimeConfig } from "./runtime-config";
import { withBasePath } from "./base-path";
import { listPhotos, listPhotosSince } from "./data-server-client";
import { getLatestLibraryPolicies } from "./data-server-client";
import type { RenditionPolicies } from "@/photos-lib/rendition-policy";
import { photoRecordToAppImage } from "./photoRecordToAppImage";
import { createRefreshCoalescer } from "./refresh-coalescer";

const POLL_INTERVAL_MS = 30_000;
const RESUME_FETCH_THRESHOLD_MS = 30_000;
/**
 * How many delta pages one tick will walk before giving up.
 *
 * The loop terminates on its own — each page's watermark is strictly above the
 * bound the request carried, so the set shrinks — but a server that reported
 * `hasMore` without advancing the watermark would spin. The cap turns that into
 * a bounded tick and one more page next time.
 */
const MAX_DELTA_PAGES = 20;

interface UsePhotoFreshnessOptions {
  onInitialLoad: (images: AppImage[]) => void;
  onMerge: (images: AppImage[]) => void;
  onLoadingChange: (loading: boolean) => void;
  onError: (message: string) => void;
  /** Receives the server-owned policies included with each list response. */
  onPolicies?: (policies: RenditionPolicies) => void;
  /** Refreshes active pending or expiring measured decisions. */
  refreshActiveResolutions?: () => void;
}

export interface PhotoFreshnessControls {
  /**
   * Force an immediate listPhotosSince and merge. Equivalent to a synthetic
   * SSE kick — call after any client-driven server mutation (uploads,
   * thumbnail backfills) so the new record shows up without waiting for the
   * next poll tick. Safe to call from cloud builds too: in the poll case
   * it just runs one extra fetchSince now.
   */
  kick: () => void;
}

/**
 * Freshness strategy. Decided once at boot from runtime config:
 *   - sse: the build is paired with the local data server. Subscribe to its
 *          /events stream (through the same-origin /api/local-data proxy,
 *          which forwards the streaming response from 127.0.0.1:9820) and
 *          call fetchSince on every kick.
 *   - poll: the build talks to the cloud data server. Re-fetch every 30 s.
 * Visibility-handling (tear down on hidden, catch up on resume) applies in
 * both cases.
 */
type FreshnessStrategy =
  | { kind: "sse" }
  | { kind: "poll" };

let strategyPromise: Promise<FreshnessStrategy> | null = null;

function getFreshnessStrategy(): Promise<FreshnessStrategy> {
  if (strategyPromise) return strategyPromise;
  strategyPromise = (async () => {
    const rc = await fetchRuntimeConfig();
    return rc?.apiGatewayUrl ? { kind: "poll" } : { kind: "sse" };
  })();
  return strategyPromise;
}

export function usePhotoFreshness({
  onInitialLoad,
  onMerge,
  onLoadingChange,
  onError,
  onPolicies,
  refreshActiveResolutions,
}: UsePhotoFreshnessOptions): PhotoFreshnessControls {
  const cursorRef = useRef<string | null>(null);
  const hiddenAtRef = useRef<number | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const strategyRef = useRef<FreshnessStrategy | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const coalescedRefreshRef = useRef<(() => Promise<void>) | null>(null);

  const computeCursor = (images: AppImage[]): string | null => {
    if (images.length === 0) return null;
    return images.reduce((max, img) => (img.updatedAt > max.updatedAt ? img : max)).updatedAt;
  };

  const fetchAll = useCallback(async () => {
    // The spinner belongs to the first load. A background re-list to pick up a
    // rendition that just landed must not blank the grid the user is looking at.
    const showSpinner = cursorRef.current === null;
    if (showSpinner) onLoadingChange(true);
    try {
      const records = await listPhotos();
      const policies = getLatestLibraryPolicies();
      if (policies) onPolicies?.(policies);
      const images = records.map((r) => photoRecordToAppImage(r, r.metadata ?? null));
      const cursor = computeCursor(images);
      if (cursor) cursorRef.current = cursor;
      onInitialLoad(images);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load photos");
    } finally {
      if (showSpinner) onLoadingChange(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchSince = useCallback(async () => {
    // A tile waiting on a better rung cannot be served by the cursor: the rung
    // arrives as a child record the page excludes, and it does not move the
    // parent's `updated_at`. So while anything is waiting, refresh the whole
    // page — one request per tick, and it stops as soon as nothing is waiting.
    refreshActiveResolutions?.();
    if (!cursorRef.current) {
      await fetchAll();
      return;
    }
    try {
      // Drained rather than taken one page per tick.
      //
      // The route cuts the delta in `updated_at` order, so a page is a prefix
      // of the changed set and the maximum `updated_at` in it is a correct
      // watermark. What the ordering does not do on its own is deliver the
      // remainder promptly: without this loop a backlog of more than one page
      // arrives at one page per poll interval, thirty seconds apart. Each pass
      // advances the cursor first, so the next request asks for what is left.
      for (let page = 0; page < MAX_DELTA_PAGES; page++) {
        const cursor = cursorRef.current;
        if (!cursor) break;
        const { records, hasMore } = await listPhotosSince(cursor);
        const policies = getLatestLibraryPolicies();
        if (policies) onPolicies?.(policies);
        if (records.length === 0) break;
        const images = records.map((r) => photoRecordToAppImage(r, r.metadata ?? null));
        const newCursor = computeCursor(images);
        onMerge(images);
        // A page that does not move the watermark cannot be followed: the next
        // request would carry the same bound and return the same rows.
        if (!newCursor || newCursor <= cursor) break;
        cursorRef.current = newCursor;
        if (!hasMore) break;
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to poll for updates");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  refreshRef.current = fetchSince;
  coalescedRefreshRef.current ??= createRefreshCoalescer(() => refreshRef.current());
  const requestRefresh = useCallback(
    () => coalescedRefreshRef.current!(),
    [],
  );

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const scheduleNextPoll = useCallback(() => {
    stopPolling();
    pollTimerRef.current = setTimeout(async () => {
      await requestRefresh();
      scheduleNextPoll();
    }, POLL_INTERVAL_MS);
  }, [requestRefresh, stopPolling]);

  const disconnectSSE = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const connectSSE = useCallback(() => {
    disconnectSSE();
    const es = new EventSource(withBasePath("/api/local-data/events"));
    esRef.current = es;
    es.onmessage = () => { void requestRefresh(); };
    es.onerror = () => { console.warn("[usePhotoFreshness] SSE error, reconnecting..."); };
  }, [disconnectSSE, requestRefresh]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      const strategy = strategyRef.current;
      if (!strategy) return;
      if (document.hidden) {
        hiddenAtRef.current = Date.now();
        if (strategy.kind === "poll") {
          stopPolling();
        } else {
          disconnectSSE();
        }
      } else {
        const hiddenDuration = hiddenAtRef.current != null ? Date.now() - hiddenAtRef.current : Infinity;
        hiddenAtRef.current = null;
        if (strategy.kind === "poll") {
          if (hiddenDuration > RESUME_FETCH_THRESHOLD_MS) void requestRefresh();
          scheduleNextPoll();
        } else {
          connectSSE();
          if (hiddenDuration > RESUME_FETCH_THRESHOLD_MS) void requestRefresh();
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [stopPolling, disconnectSSE, scheduleNextPoll, connectSSE, requestRefresh]);

  useEffect(() => {
    cursorRef.current = null;
    let cancelled = false;

    void (async () => {
      // Start the list immediately and resolve the strategy alongside it.
      //
      // The strategy only decides what to subscribe to *after* the first load
      // — SSE or a poll timer — and the first load never needed it. Awaiting it
      // first put a runtime-config round trip in front of every page load, and
      // in the cloud that request is a dynamic route on the same Lambda as
      // everything else, so a cold one held the grid on its empty state for
      // seconds before the library call had even been issued.
      const [strategy] = await Promise.all([getFreshnessStrategy(), fetchAll()]);
      if (cancelled) return;
      strategyRef.current = strategy;
      if (strategy.kind === "sse") {
        connectSSE();
      } else {
        scheduleNextPoll();
      }
    })();

    return () => {
      cancelled = true;
      stopPolling();
      disconnectSSE();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { kick: () => { void requestRefresh(); } };
}
