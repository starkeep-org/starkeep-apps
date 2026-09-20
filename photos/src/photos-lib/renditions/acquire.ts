import { acquireRenditions, DESKTOP_RUNG_SHARES, DESKTOP_FALLBACK_SHARE, type AcquisitionEntry } from "@starkeep/photos-ladder";
import { type SignedFetch } from "./store";

/** Only the listing endpoint reports local original availability. */
export async function originalFacts(call: SignedFetch, id: string) {
  const where = encodeURIComponent(JSON.stringify({ id: { eq: id } }));
  const response = await call(`/data/records?where=${where}&limit=1&include=metadata`);
  if (!response.ok) throw new Error(`original availability failed: ${response.status}`);
  const body = await response.json() as { records: Array<{ availability?: { state: string }; metadata?: { width?: number; height?: number } }> };
  return body.records[0] ?? null;
}

export async function originalIsInstant(call: SignedFetch, id: string): Promise<boolean> {
  return (await originalFacts(call, id))?.availability?.state === "instant";
}

let lock: Promise<unknown> = Promise.resolve();
/** Serialize Photos' HTTP acquisition passes within the server process. */
export function fetchPublishedRenditions(call: SignedFetch, requestedKeys: readonly string[]) {
  const run = async () => {
    const entries: AcquisitionEntry[] = [];
    let cursor: string | null = null;
    let budgetBytes = Infinity;
    do {
      const response = await call(`/app-data/residency${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!response.ok) throw new Error(`residency failed: ${response.status}`);
      const page = await response.json() as { budgetBytes: number | null; nextCursor: string | null;
        entries: Array<{ subKey: string; sizeBytes: number; resident: boolean; lastOpenedAtMs: number | null }> };
      budgetBytes = page.budgetBytes ?? Infinity;
      // A node under no ceiling has nothing to weigh, and the sweep calls this
      // once a page. Leaving here costs one request instead of walking the
      // whole plane for an answer that is already known.
      if (!requestedKeys.length && budgetBytes === Infinity) return [];
      for (const entry of page.entries) {
        if (!entry.subKey.startsWith("renditions/") && !entry.subKey.startsWith("local/renditions/")) continue;
        entries.push({ key: entry.subKey, sizeClass: entry.subKey.replace(/^local\//, "").split("/")[2]!, sizeBytes: entry.sizeBytes,
          resident: entry.resident, lastOpenedAtMs: entry.lastOpenedAtMs, recencyAtMs: null, fetchable: !entry.subKey.startsWith("local/") });
      }
      cursor = page.nextCursor;
    } while (cursor);
    const parentIds = [...new Set(entries.map(entry => entry.key.replace(/^local\//, "").split("/")[1]!))];
    const dates = new Map<string, number | null>();
    for (let offset = 0; offset < parentIds.length; offset += 500) {
      const where = encodeURIComponent(JSON.stringify({ id: { in: parentIds.slice(offset, offset + 500) } }));
      const response = await call(`/data/records?where=${where}&limit=500&include=metadata`);
      if (!response.ok) throw new Error(`record dates failed: ${response.status}`);
      const body = await response.json() as { records: Array<{ id: string; created_at?: string; metadata?: { captured_at?: string } }> };
      for (const record of body.records) {
        const date = Date.parse(record.metadata?.captured_at ?? record.created_at ?? "");
        dates.set(record.id, Number.isFinite(date) ? date : null);
      }
    }
    for (const entry of entries) entry.recencyAtMs = dates.get(entry.key.replace(/^local\//, "").split("/")[1]!) ?? null;
    const fetched: string[] = [];
    for (const key of requestedKeys.length ? requestedKeys : [undefined]) {
      const result = await acquireRenditions({ entries, budgetBytes, shares: DESKTOP_RUNG_SHARES, fallbackShare: DESKTOP_FALLBACK_SHARE, requestedKey: key, prefetch: false,
        fetch: async subKey => {
          const response = await call(`/app-data/files/${subKey}/fetch`, { method: "POST" });
          if (!response.ok) return false;
          const result = await response.json() as { landed: boolean; reason?: string };
          return result.landed || result.reason === "already-here";
        },
        drop: async subKey => {
          const response = await call(`/app-data/files/${subKey}/blob`, { method: "DELETE" });
          return response.ok && (await response.json() as { dropped: boolean }).dropped;
        } });
      for (const entry of entries) {
        if (result.dropped.includes(entry.key)) entry.resident = false;
        if (result.fetched.includes(entry.key)) entry.resident = true;
      }
      fetched.push(...result.fetched);
    }
    return fetched;
  };
  const result = lock.then(run, run);
  lock = result.catch(() => undefined);
  return result;
}
