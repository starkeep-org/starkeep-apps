import { PHOTOS_FALLBACK_SHARE, PHOTOS_RUNG_SHARES, type RungRetention } from "./acquisition-policy";

export interface AcquisitionEntry {
  key: string;
  sizeClass: string;
  sizeBytes: number;
  resident: boolean;
  lastOpenedAtMs: number | null;
  recencyAtMs: number | null;
  /** Original availability and decoder policy determine whether fetching is allowed. */
  fetchable: boolean;
}

/** Negative means that Photos gives up a before b. */
export function compareRenditionRank(a: AcquisitionEntry, b: AcquisitionEntry): number {
  if ((a.lastOpenedAtMs === null) !== (b.lastOpenedAtMs === null)) return a.lastOpenedAtMs === null ? -1 : 1;
  if (a.lastOpenedAtMs !== b.lastOpenedAtMs) return a.lastOpenedAtMs! - b.lastOpenedAtMs!;
  if (a.recencyAtMs === b.recencyAtMs) return 0;
  if (a.recencyAtMs === null) return -1;
  if (b.recencyAtMs === null) return 1;
  return a.recencyAtMs - b.recencyAtMs;
}

/** Callers serialize this pass with publication, sync, and other acquisition. */
export async function acquireRenditions(options: {
  entries: readonly AcquisitionEntry[];
  budgetBytes: number;
  shares?: Readonly<Record<string, RungRetention>>;
  fallbackShare?: RungRetention;
  requestedKey?: string;
  prefetch?: boolean;
  maxBytes?: number;
  fetch: (key: string) => Promise<boolean>;
  drop: (key: string) => Promise<boolean>;
}): Promise<{ fetched: string[]; dropped: string[] }> {
  const shares = options.shares ?? PHOTOS_RUNG_SHARES;
  const fallback = options.fallbackShare ?? PHOTOS_FALLBACK_SHARE;
  const result = { fetched: [] as string[], dropped: [] as string[] };
  const groups = new Map<string, AcquisitionEntry[]>();
  for (const entry of options.entries) {
    const group = Object.hasOwn(shares, entry.sizeClass) ? entry.sizeClass : "fallback";
    const list = groups.get(group) ?? [];
    list.push(entry);
    groups.set(group, list);
  }
  const totalShares = Object.values(shares).reduce((n, p) => n + p.share, fallback.share);
  let transferred = 0;
  for (const [group, entries] of groups) {
    const policy = shares[group] ?? fallback;
    const ceiling = Math.floor(options.budgetBytes * policy.share / totalShares);
    const ordered = entries.filter(e => e.resident || (e.fetchable &&
      (e.key === options.requestedKey || (options.prefetch !== false && policy.prefetch))))
      .sort((a, b) => Number(b.key === options.requestedKey) - Number(a.key === options.requestedKey) ||
        compareRenditionRank(b, a) || a.key.localeCompare(b.key));
    const wanted = new Set<string>();
    let selectedBytes = 0;
    for (const entry of ordered) {
      if (entry.sizeBytes < 0 || !Number.isFinite(entry.sizeBytes)) continue;
      if (selectedBytes + entry.sizeBytes > ceiling) continue;
      wanted.add(entry.key);
      selectedBytes += entry.sizeBytes;
    }
    let held = entries.filter(e => e.resident).reduce((n, e) => n + e.sizeBytes, 0);
    for (const entry of entries.filter(e => e.resident && !wanted.has(e.key)).sort(compareRenditionRank)) {
      if (await options.drop(entry.key)) {
        held -= entry.sizeBytes;
        result.dropped.push(entry.key);
      }
    }
    for (const entry of ordered) {
      if (entry.resident || !wanted.has(entry.key) || !entry.fetchable) continue;
      if (held + entry.sizeBytes > ceiling || transferred + entry.sizeBytes > (options.maxBytes ?? Infinity)) continue;
      transferred += entry.sizeBytes;
      if (await options.fetch(entry.key)) {
        held += entry.sizeBytes;
        result.fetched.push(entry.key);
      }
    }
  }
  return result;
}
