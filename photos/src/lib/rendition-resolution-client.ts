import type { RenditionChoice } from "@/photos-lib/rendition-resolution";
import { canonicalTarget, type RenditionPolicies, type MediaPolicyKind } from "@/photos-lib/rendition-policy";
import { requestOwnApi } from "./data-server-client";

export const RENDITION_BATCH_MAX = 100;
const FLUSH_DELAY_MS = 12;
const EXPIRY_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * How soon the cache asks again about entries still waiting, doubling up to
 * the cap. Nothing tells this browser when a phone's upload lands: the rows
 * arrived long before their files, so the library poll sees no change. The
 * short start fits the usual case, a phone online and uploading; the cap
 * bounds the cost of a tile whose bytes are not coming soon. A request that
 * failed outright waits on the same timer, and the same cap bounds what a
 * persistent failure costs.
 */
export const RETRY_START_MS = 5_000;
export const RETRY_MAX_MS = 60_000;

export type UrlLifetime =
  | { kind: "expires"; expires_at: string }
  | { kind: "non-expiring" };

export interface VideoDecision {
  poster?: ResolutionMediaEntry;
  playback?: ResolutionMediaEntry;
}

export interface ResolutionMediaEntry {
  id: string;
  url?: string;
  width: number;
  height: number;
  long_edge?: number;
  longEdge?: number;
  type: string;
  url_lifetime?: UrlLifetime;
  urlLifetime?: UrlLifetime;
}

export type ResolutionDecision = RenditionChoice | VideoDecision;
export type ResolutionStatus = "queued" | "in-flight" | "ready" | "pending" | "failed";

export interface ResolutionEntry {
  key: string;
  recordId: string;
  mediaKind: MediaPolicyKind;
  policyVersion: string;
  requiredLongEdge: number;
  canonicalTargetLongEdge: number;
  status: ResolutionStatus;
  decision?: ResolutionDecision;
  error?: string;
  effectiveCoverage?: { requiredLongEdgeMin: number; requiredLongEdgeMax: number };
  generation: number;
}

interface ResolutionResponse {
  policies: RenditionPolicies;
  results: Array<
    | { recordId: string; status: "missing" }
    | {
        recordId: string;
        status: "resolved";
        mediaKind: MediaPolicyKind;
        policyVersion: string;
        canonicalTargetLongEdge: number;
        effectiveCoverage?: { requiredLongEdgeMin: number; requiredLongEdgeMax: number };
        decision: ResolutionDecision;
      }
  >;
}

export function resolutionKey(recordId: string, policyVersion: string, target: number): string {
  return `${recordId}\u0000${policyVersion}\u0000${target}`;
}

/**
 * Whether a decision is still waiting on bytes, so the retry timer asks again.
 *
 * A video's decision names no state; a missing poster or playback entry is its
 * only sign of waiting. Counting that as settled left a tile on its placeholder
 * for the session when the answer came before the poster did — a phone's
 * poster lands seconds after its video record, and the grid asks in between.
 */
function isPendingDecision(kind: MediaPolicyKind, decision: ResolutionDecision): boolean {
  if (kind === "video") {
    const video = decision as VideoDecision;
    return !video.poster || !video.playback;
  }
  // A rung awaiting its upload is waiting as much as one being derived; the
  // difference is only who will produce it, which is not this cache's concern.
  const ideal = (decision as RenditionChoice).ideal;
  const state = ideal?.state ?? "pending";
  return ideal?.available === false && (state === "pending" || state === "awaiting-upload");
}

/** Whether the retry timer should ask about an entry again. */
function isWaiting(entry: ResolutionEntry): boolean {
  return entry.status === "pending" || entry.status === "failed";
}

function lifetimeOf(entry: { urlLifetime?: UrlLifetime; url_lifetime?: UrlLifetime } | undefined) {
  return entry?.urlLifetime ?? entry?.url_lifetime;
}

function mediaEntries(kind: MediaPolicyKind, decision: ResolutionDecision | undefined) {
  if (!decision) return [];
  if (kind === "video") {
    const video = decision as VideoDecision;
    return [video.poster, video.playback].filter(Boolean) as ResolutionMediaEntry[];
  }
  const still = decision as RenditionChoice;
  return [still.ideal, still.fallback].filter(Boolean) as Array<RenditionChoice["ideal"] & {
    urlLifetime?: UrlLifetime;
  }>;
}

function expiresSoon(entry: ResolutionEntry, now = Date.now()): boolean {
  for (const media of mediaEntries(entry.mediaKind, entry.decision)) {
    const lifetime = lifetimeOf(media);
    if (lifetime?.kind === "expires") {
      const expiresAt = Date.parse(lifetime.expires_at);
      if (Number.isFinite(expiresAt) && expiresAt - now <= EXPIRY_REFRESH_BUFFER_MS) return true;
    }
  }
  return false;
}

function retainStableUrls(
  kind: MediaPolicyKind,
  previous: ResolutionDecision | undefined,
  next: ResolutionDecision,
): ResolutionDecision {
  const priorById = new Map(
    mediaEntries(kind, previous)
      .filter((entry) => entry.id && entry.url)
      .map((entry) => [entry.id, entry]),
  );
  const retain = <T extends { id?: string; url?: string; urlLifetime?: UrlLifetime; url_lifetime?: UrlLifetime }>(entry: T): T => {
    const prior = entry.id ? priorById.get(entry.id) : undefined;
    if (!prior?.url) return entry;
    const lifetime = lifetimeOf(prior);
    const valid = lifetime?.kind === "non-expiring" ||
      (lifetime?.kind === "expires" && Date.parse(lifetime.expires_at) > Date.now() + 30_000);
    return valid
      ? { ...entry, url: prior.url, urlLifetime: lifetime }
      : entry;
  };
  if (kind === "video") {
    const video = next as VideoDecision;
    return {
      ...(video.poster ? { poster: retain(video.poster) } : {}),
      ...(video.playback ? { playback: retain(video.playback) } : {}),
    };
  }
  const still = next as RenditionChoice;
  return {
    ideal: retain(still.ideal),
    ...(still.fallback ? { fallback: retain(still.fallback) } : {}),
  };
}

export class RenditionResolutionCache {
  private entries = new Map<string, ResolutionEntry>();
  private listeners = new Map<string, Set<() => void>>();
  private policyListeners = new Set<() => void>();
  private queued = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextGeneration = 1;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = RETRY_START_MS;
  /** Keys that have answered `pending` or failed since they were last ready. */
  private waiting = new Set<string>();

  constructor(
    private policies: RenditionPolicies | null,
    private readonly send: (requests: Array<{
      recordId: string;
      policyVersion: string;
      requiredLongEdge: number;
      targetLongEdge: number;
    }>) => Promise<ResolutionResponse> = (requests) =>
      requestOwnApi<ResolutionResponse>("/api/photos/renditions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      }),
  ) {}

  setPolicies(policies: RenditionPolicies | null): void {
    if (!policies) return;
    const changed = JSON.stringify(this.policies) !== JSON.stringify(policies);
    if (this.policies) {
      for (const [key, entry] of this.entries) {
        if (entry.policyVersion !== policies[entry.mediaKind].version) {
          this.entries.delete(key);
          this.queued.delete(key);
          this.notify(key);
        }
      }
    }
    this.policies = policies;
    if (changed) for (const listener of this.policyListeners) listener();
  }

  getPolicy(kind: MediaPolicyKind) {
    return this.policies?.[kind] ?? null;
  }

  subscribePolicy = (listener: () => void) => {
    this.policyListeners.add(listener);
    return () => this.policyListeners.delete(listener);
  };

  get(key: string | null): ResolutionEntry | undefined {
    return key ? this.entries.get(key) : undefined;
  }

  subscribe(key: string | null, listener: () => void): () => void {
    if (!key) return () => {};
    let listeners = this.listeners.get(key);
    if (!listeners) this.listeners.set(key, (listeners = new Set()));
    listeners.add(listener);
    // A tile scrolled back into view over an entry still waiting or failed.
    this.scheduleRetry();
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) this.listeners.delete(key);
    };
  }

  request(recordId: string, kind: MediaPolicyKind, requiredLongEdge: number, target: number): string | null {
    const policy = this.policies?.[kind];
    if (!policy || requiredLongEdge <= 0 || target <= 0) return null;
    const key = resolutionKey(recordId, policy.version, target);
    const existing = this.entries.get(key);
    if (existing && !expiresSoon(existing)) return key;
    const generation = this.nextGeneration++;
    this.entries.set(key, {
      key,
      recordId,
      mediaKind: kind,
      policyVersion: policy.version,
      requiredLongEdge,
      canonicalTargetLongEdge: target,
      status: "queued",
      decision: existing?.decision,
      generation,
    });
    this.queued.add(key);
    this.notify(key);
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_DELAY_MS);
    return key;
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const keys = [...this.queued];
    this.queued.clear();
    let progressed = false;
    for (let offset = 0; offset < keys.length; offset += RENDITION_BATCH_MAX) {
      const chunk = keys.slice(offset, offset + RENDITION_BATCH_MAX);
      const batch = chunk.map((key) => this.entries.get(key)).filter(Boolean) as ResolutionEntry[];
      for (const entry of batch) {
        entry.status = "in-flight";
        this.notify(entry.key);
      }
      try {
        const response = await this.send(batch.map((entry) => ({
          recordId: entry.recordId,
          policyVersion: entry.policyVersion,
          requiredLongEdge: entry.requiredLongEdge,
          targetLongEdge: entry.canonicalTargetLongEdge,
        })));
        this.setPolicies(response.policies);
        const handledKeys = new Set<string>();
        for (const result of response.results) {
          if (result.status === "missing") {
            const matching = batch.filter((entry) => entry.recordId === result.recordId);
            for (const old of matching) handledKeys.add(old.key);
            for (const old of matching) this.fail(old, "record not found");
            continue;
          }
          const resultPolicy = response.policies[result.mediaKind];
          const matching = batch.filter(
            (entry) =>
              entry.recordId === result.recordId &&
              canonicalTarget(resultPolicy, entry.requiredLongEdge) === result.canonicalTargetLongEdge,
          );
          for (const old of matching) handledKeys.add(old.key);
          if (matching.length === 0) continue;
          const newKey = resolutionKey(result.recordId, result.policyVersion, result.canonicalTargetLongEdge);
          const previous = this.entries.get(newKey);
          const source = matching.reduce((latest, entry) => entry.generation > latest.generation ? entry : latest, matching[0]!);
          if (previous && previous.generation > source.generation) continue;
          const next: ResolutionEntry = {
            ...source,
            key: newKey,
            policyVersion: result.policyVersion,
            canonicalTargetLongEdge: result.canonicalTargetLongEdge,
            effectiveCoverage: result.effectiveCoverage,
            decision: retainStableUrls(result.mediaKind, previous?.decision ?? source.decision, result.decision),
            status: isPendingDecision(result.mediaKind, result.decision) ? "pending" : "ready",
            error: undefined,
          };
          for (const old of matching) {
            if (old.key !== newKey) {
              this.entries.delete(old.key);
              this.notify(old.key);
            }
          }
          if (next.status === "pending") {
            this.waiting.add(newKey);
          } else if (matching.some((old) => this.waiting.delete(old.key)) || this.waiting.delete(newKey)) {
            progressed = true;
          }
          this.entries.set(newKey, next);
          this.notify(newKey);
        }
        for (const entry of batch) {
          if (!handledKeys.has(entry.key)) {
            this.fail(entry, "resolution omitted");
          }
        }
      } catch (error) {
        for (const entry of batch) {
          this.fail(entry, error instanceof Error ? error.message : "resolution failed");
        }
      }
    }
    // Something that was waiting arrived, so more is likely on its way: a
    // phone uploads a library file after file. Ask again soon.
    if (progressed) this.resetRetry();
    else this.scheduleRetry();
  }

  /**
   * An image this cache handed out would not load: its bytes are not where
   * the URL points yet, or the URL lapsed. The entry waits again, without the
   * URL that failed, so the retry timer resolves it afresh and the tile gets a
   * newly signed URL rather than the same one back.
   */
  reportLoadFailure(key: string, url: string): void {
    const entry = this.entries.get(key);
    if (!entry?.decision) return;
    let found = false;
    const strip = <T extends { url?: string }>(media: T | undefined): T | undefined => {
      if (!media || media.url !== url) return media;
      found = true;
      const { url: _failed, ...rest } = media;
      return rest as T;
    };
    let decision: ResolutionDecision;
    if (entry.mediaKind === "video") {
      const video = entry.decision as VideoDecision;
      const poster = strip(video.poster);
      const playback = strip(video.playback);
      decision = { ...(poster ? { poster } : {}), ...(playback ? { playback } : {}) };
    } else {
      const still = entry.decision as RenditionChoice;
      const fallback = strip(still.fallback);
      decision = { ideal: strip(still.ideal)!, ...(fallback ? { fallback } : {}) };
    }
    // A failure report about a URL this entry no longer holds is about an
    // answer already replaced.
    if (!found) return;
    this.entries.set(key, { ...entry, decision, status: "pending" });
    this.waiting.add(key);
    this.notify(key);
    this.resetRetry();
  }

  refreshPending(): void {
    for (const entry of this.entries.values()) {
      const active = (this.listeners.get(entry.key)?.size ?? 0) > 0;
      if (active && (isWaiting(entry) || (entry.status === "ready" && expiresSoon(entry)))) {
        entry.status = "queued";
        entry.generation = this.nextGeneration++;
        this.queued.add(entry.key);
        this.notify(entry.key);
      }
    }
    if (this.queued.size > 0) this.timer ??= setTimeout(() => void this.flush(), FLUSH_DELAY_MS);
  }

  retainRecords(recordIds: ReadonlySet<string>): void {
    for (const [key, entry] of this.entries) {
      if (!recordIds.has(entry.recordId)) {
        this.entries.delete(key);
        this.queued.delete(key);
        this.waiting.delete(key);
        this.notify(key);
      }
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.queued.clear();
  }

  /** Arm the retry timer when an entry on screen is still waiting or failed. */
  private scheduleRetry(): void {
    if (this.retryTimer) return;
    if (!this.hasActiveWaiting()) {
      this.retryDelayMs = RETRY_START_MS;
      return;
    }
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(delay * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.refreshPending();
    }, delay);
  }

  private resetRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryDelayMs = RETRY_START_MS;
    this.scheduleRetry();
  }

  private hasActiveWaiting(): boolean {
    for (const entry of this.entries.values()) {
      if (isWaiting(entry) && (this.listeners.get(entry.key)?.size ?? 0) > 0) return true;
    }
    return false;
  }

  /**
   * Mark an entry failed, unless a newer request replaced it. A failed entry
   * waits like a pending one: the retry timer asks again at the same backoff,
   * so a dropped request or a brief outage does not strand a tile for the
   * session.
   */
  private fail(previous: ResolutionEntry, error: string): void {
    if (this.entries.get(previous.key)?.generation !== previous.generation) return;
    this.entries.set(previous.key, { ...previous, status: "failed", error });
    this.waiting.add(previous.key);
    this.notify(previous.key);
  }

  private notify(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener();
  }
}
