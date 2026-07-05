import { useEffect, useRef, useCallback } from "react";
import type { AppImage } from "@/photos-lib";
import { fetchRuntimeConfig } from "./runtime-config";
import { withBasePath } from "./base-path";
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

export interface PhotoSyncControls {
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

export function usePhotoSync({ onInitialLoad, onMerge, onLoadingChange, onError }: UsePhotoSyncOptions): PhotoSyncControls {
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
      const images = records.map((r) => photoRecordToAppImage(r, r.metadata ?? null));
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
        const images = records.map((r) => photoRecordToAppImage(r, r.metadata ?? null));
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

  const connectSSE = useCallback(() => {
    disconnectSSE();
    const es = new EventSource(withBasePath("/api/local-data/events"));
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
          connectSSE();
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

  return { kick: () => { void fetchSince(); } };
}
