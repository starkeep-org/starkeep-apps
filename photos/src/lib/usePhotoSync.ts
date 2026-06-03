import { useEffect, useRef, useCallback } from "react";
import type { AppImage } from "@/photos-lib";
import { fetchRuntimeConfig } from "./runtime-config";
import { listPhotos, listPhotosSince } from "./data-server-client";
import { photoRecordToAppImage } from "./photoRecordToAppImage";

const POLL_INTERVAL_MS = 30_000;
const RESUME_FETCH_THRESHOLD_MS = 30_000;

interface UsePhotoSyncOptions {
  onInitialLoad: (images: AppImage[]) => void;
  onMerge: (images: AppImage[]) => void;
  onLoadingChange: (loading: boolean) => void;
  onError: (message: string) => void;
}

/**
 * Freshness strategy. Decided once at boot from runtime config:
 *   - sse: the build is paired with a local data server. Subscribe to its
 *          /events stream and call fetchSince on every kick.
 *   - poll: the build talks to the cloud data server. Re-fetch every 30 s.
 * Visibility-handling (tear down on hidden, catch up on resume) applies in
 * both cases.
 */
type FreshnessStrategy =
  | { kind: "sse"; localUrl: string }
  | { kind: "poll" };

let strategyPromise: Promise<FreshnessStrategy> | null = null;

function getFreshnessStrategy(): Promise<FreshnessStrategy> {
  if (strategyPromise) return strategyPromise;
  strategyPromise = (async () => {
    const rc = await fetchRuntimeConfig();
    const hasLocal = !!rc?.localDataServerUrl;
    const hasRemote = !!rc?.apiGatewayUrl;
    if (hasLocal && hasRemote) {
      console.warn(
        "[usePhotoSync] Both localDataServerUrl and apiGatewayUrl are set — preferring local SSE freshness. Exactly one should be set per deployment build.",
      );
    }
    if (hasLocal) {
      return { kind: "sse", localUrl: rc!.localDataServerUrl! };
    }
    if (hasRemote) {
      return { kind: "poll" };
    }
    // No runtime config served (e.g. dev with no .well-known file): assume
    // the same-origin local-data proxy and poll. SSE on /events requires a
    // direct local data server URL, which we don't have here.
    console.warn("[usePhotoSync] No data server URL in runtime config — falling back to polling");
    return { kind: "poll" };
  })();
  return strategyPromise;
}

export function usePhotoSync({ onInitialLoad, onMerge, onLoadingChange, onError }: UsePhotoSyncOptions): void {
  const cursorRef = useRef<string | null>(null);
  const hiddenAtRef = useRef<number | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const strategyRef = useRef<FreshnessStrategy | null>(null);

  const computeCursor = (images: AppImage[]): string | null => {
    if (images.length === 0) return null;
    return images.reduce((max, img) => (img.updatedAt > max.updatedAt ? img : max)).updatedAt;
  };

  const fetchAll = useCallback(async () => {
    onLoadingChange(true);
    try {
      const records = await listPhotos();
      const images = records.map((r) => photoRecordToAppImage(r, null));
      const cursor = computeCursor(images);
      if (cursor) cursorRef.current = cursor;
      onInitialLoad(images);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load photos");
    } finally {
      onLoadingChange(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchSince = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!cursor) {
      await fetchAll();
      return;
    }
    try {
      const records = await listPhotosSince(cursor);
      if (records.length > 0) {
        const images = records.map((r) => photoRecordToAppImage(r, null));
        const newCursor = computeCursor(images);
        if (newCursor && newCursor > cursor) cursorRef.current = newCursor;
        onMerge(images);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to poll for updates");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const scheduleNextPoll = useCallback(() => {
    stopPolling();
    pollTimerRef.current = setTimeout(async () => {
      await fetchSince();
      scheduleNextPoll();
    }, POLL_INTERVAL_MS);
  }, [fetchSince, stopPolling]);

  const disconnectSSE = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const connectSSE = useCallback((localUrl: string) => {
    disconnectSSE();
    const es = new EventSource(`${localUrl}/events`);
    esRef.current = es;
    es.onmessage = () => { void fetchSince(); };
    es.onerror = () => { console.warn("[usePhotoSync] SSE error, reconnecting..."); };
  }, [disconnectSSE, fetchSince]);

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
          if (hiddenDuration > RESUME_FETCH_THRESHOLD_MS) void fetchSince();
          scheduleNextPoll();
        } else {
          connectSSE(strategy.localUrl);
          if (hiddenDuration > RESUME_FETCH_THRESHOLD_MS) void fetchSince();
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [stopPolling, disconnectSSE, scheduleNextPoll, connectSSE, fetchSince]);

  useEffect(() => {
    cursorRef.current = null;
    let cancelled = false;

    void (async () => {
      const strategy = await getFreshnessStrategy();
      if (cancelled) return;
      strategyRef.current = strategy;
      await fetchAll();
      if (cancelled) return;
      if (strategy.kind === "sse") {
        connectSSE(strategy.localUrl);
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
}
