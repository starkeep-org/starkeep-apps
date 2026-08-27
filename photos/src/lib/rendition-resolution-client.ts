import type { RenditionChoice } from "@/photos-lib/rendition-resolution";
import { canonicalTarget, type RenditionPolicies, type MediaPolicyKind } from "@/photos-lib/rendition-policy";
import { requestOwnApi } from "./data-server-client";

export const RENDITION_BATCH_MAX = 100;
const FLUSH_DELAY_MS = 12;
const EXPIRY_REFRESH_BUFFER_MS = 5 * 60 * 1000;

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

function isPendingDecision(kind: MediaPolicyKind, decision: ResolutionDecision): boolean {
  return kind === "still" && (decision as RenditionChoice).ideal?.available === false &&
    ((decision as RenditionChoice).ideal.state ?? "pending") === "pending";
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
            for (const old of matching) this.updateIfCurrent(old, { ...old, status: "failed", error: "record not found" });
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
          this.entries.set(newKey, next);
          this.notify(newKey);
        }
        for (const entry of batch) {
          if (!handledKeys.has(entry.key)) {
            this.updateIfCurrent(entry, { ...entry, status: "failed", error: "resolution omitted" });
          }
        }
      } catch (error) {
        for (const entry of batch) {
          this.updateIfCurrent(entry, {
            ...entry,
            status: "failed",
            error: error instanceof Error ? error.message : "resolution failed",
          });
        }
      }
    }
  }

  refreshPending(): void {
    for (const entry of this.entries.values()) {
      const active = (this.listeners.get(entry.key)?.size ?? 0) > 0;
      if (active && (entry.status === "pending" || (entry.status === "ready" && expiresSoon(entry)))) {
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
        this.notify(key);
      }
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queued.clear();
  }

  private updateIfCurrent(previous: ResolutionEntry, next: ResolutionEntry): void {
    if (this.entries.get(previous.key)?.generation !== previous.generation) return;
    this.entries.set(previous.key, next);
    this.notify(previous.key);
  }

  private notify(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener();
  }
}
