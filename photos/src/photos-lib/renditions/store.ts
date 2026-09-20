/**
 * Photos' rendition table, as this app reads and writes it.
 *
 * The rows live on the app-private plane — `/app-data/db/renditions` — and the
 * bytes live beside them under `/app-data/files/renditions/…`. Nothing here
 * touches the shared plane, which is the whole point: a rung is Photos'
 * business and stopped being a record every other app has to filter out.
 *
 * ## Why this module and not the platform
 *
 * The platform used to answer "which derived children does this record have and
 * how big is each" by joining labelled children to their dimensions, and every
 * Photos read path consumed the result. With no shared children there is
 * nothing to join, so the gathering half moves here and the deciding half stays
 * in `@starkeep/photos-ladder` where it always was. The resolver is unchanged;
 * only its input is.
 *
 * ## Three questions, three requests
 *
 * A page of records needs the rows, the URLs to paint them with, and whether
 * the bytes are on this node. They are three calls rather than one because they
 * come from three different places — the app's table, object storage, and this
 * node's resident set — and the platform deliberately holds no joined view of
 * an app's private plane.
 */

import {
  RENDITIONS_TABLE,
  RENDITION_SUBKEY_PREFIX,
  type RenditionRow,
} from "@/photos-lib/ladder";

/**
 * Something that can issue authenticated data-plane requests.
 *
 * Headers are a plain record rather than `HeadersInit`, matching what every
 * caller's `signedFetch` already accepts.
 */
export interface SignedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type SignedFetch = (path: string, init?: SignedFetchInit) => Promise<Response>;

/** The query grammar's page cap, and the `in`-list cap it shares. */
const MAX_ROWS_PER_PAGE = 500;
const MAX_PARENTS_PER_QUERY = 500;
/** `/app-data/file-urls` takes at most this many keys per call. */
const MAX_URLS_PER_BATCH = 200;
/** `/app-data/residency/lookup` takes at most this many keys per call. */
const MAX_RESIDENCY_PER_BATCH = 500;

/** A row plus the two node-local facts a reader needs beside it. */
export interface HydratedRendition extends RenditionRow {
  /** Whether this node holds the bytes. False means the row is here and they are not. */
  readonly availableHere: boolean;
  /** A time-limited URL for the bytes, absent when none could be minted. */
  readonly url?: string;
}

export class RenditionStoreError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    detail: string,
  ) {
    super(`Rendition store ${operation} failed (${status}): ${detail}`);
    this.name = "RenditionStoreError";
  }
}

async function fail(operation: string, res: Response): Promise<never> {
  throw new RenditionStoreError(operation, res.status, await res.text().catch(() => ""));
}

/**
 * Every rung recorded for these parents, keyed by parent.
 *
 * Paged rather than single-shot: two hundred photographs with five rungs each
 * is a thousand rows and the grammar's page is five hundred, so a caller that
 * read one page would silently see three fifths of the library's renditions
 * and derive the rest again.
 *
 * Ordering is the primary key's own, which is what makes the keyset cursor a
 * genuine prefix — a page cut on any other key hands back an arbitrary slice.
 */
export async function loadRenditionRows(
  signedFetch: SignedFetch,
  parentIds: readonly string[],
): Promise<Map<string, RenditionRow[]>> {
  const byParent = new Map<string, RenditionRow[]>();
  const unique = [...new Set(parentIds)];
  for (let i = 0; i < unique.length; i += MAX_PARENTS_PER_QUERY) {
    const chunk = unique.slice(i, i + MAX_PARENTS_PER_QUERY);
    let pageToken: string | null = null;
    do {
      const params = [
        `where=${encodeURIComponent(JSON.stringify({ parent_record_id: { in: chunk } }))}`,
        `limit=${MAX_ROWS_PER_PAGE}`,
        "order=parent_record_id.asc,size_class.asc",
      ];
      if (pageToken) params.push(`page_token=${encodeURIComponent(pageToken)}`);
      const res = await signedFetch(`/app-data/db/${RENDITIONS_TABLE}?${params.join("&")}`);
      if (!res.ok) return fail("read", res);
      const body = (await res.json()) as {
        rows?: RenditionRow[];
        page_token?: string | null;
      };
      for (const row of body.rows ?? []) {
        const list = byParent.get(row.parent_record_id);
        if (list) list.push(row);
        else byParent.set(row.parent_record_id, [row]);
      }
      pageToken = body.page_token ?? null;
    } while (pageToken !== null);
  }
  return byParent;
}

/** The rungs one photograph has, which is what a publisher checks before writing. */
export async function loadRenditionsOf(
  signedFetch: SignedFetch,
  parentId: string,
): Promise<RenditionRow[]> {
  return (await loadRenditionRows(signedFetch, [parentId])).get(parentId) ?? [];
}

/**
 * Which of these blobs this node holds.
 *
 * Absent from the answer means absent from the plane. A sub-key whose row
 * exists but whose bytes do not comes back with `resident: false`, which is the
 * case the whole call exists for: the row syncs and the bytes do not, because
 * an app-private blob is never prefetched by a round.
 */
export async function loadResidency(
  signedFetch: SignedFetch,
  subKeys: readonly string[],
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const unique = [...new Set(subKeys)];
  for (let i = 0; i < unique.length; i += MAX_RESIDENCY_PER_BATCH) {
    const chunk = unique.slice(i, i + MAX_RESIDENCY_PER_BATCH);
    const res = await signedFetch(`/app-data/residency/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subKeys: chunk }),
    });
    if (!res.ok) return fail("residency", res);
    const body = (await res.json()) as {
      entries?: Array<{ subKey: string; resident: boolean }>;
    };
    for (const entry of body.entries ?? []) out.set(entry.subKey, entry.resident);
  }
  return out;
}

/** Time-limited URLs for rendition bytes, keyed by sub-key. */
export async function loadRenditionUrls(
  signedFetch: SignedFetch,
  subKeys: readonly string[],
  expiresIn = 3600,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(subKeys)];
  for (let i = 0; i < unique.length; i += MAX_URLS_PER_BATCH) {
    const chunk = unique.slice(i, i + MAX_URLS_PER_BATCH);
    const res = await signedFetch(`/app-data/file-urls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subKeys: chunk, expiresIn }),
    });
    if (!res.ok) return fail("file-urls", res);
    const body = (await res.json()) as { urls?: Record<string, string> };
    for (const [subKey, url] of Object.entries(body.urls ?? {})) out.set(subKey, url);
  }
  return out;
}

/**
 * The rows for a page of records, with URLs and local availability attached.
 *
 * One call per fact, so a caller that needs only the rows — the sweep deciding
 * what to derive — does not pay for URLs it will not open.
 */
export async function loadHydratedRenditions(
  signedFetch: SignedFetch,
  parentIds: readonly string[],
  options: { urls?: boolean } = {},
): Promise<Map<string, HydratedRendition[]>> {
  const rows = await loadRenditionRows(signedFetch, parentIds);
  const subKeys = [...rows.values()].flat().map((row) => row.sub_key);
  if (subKeys.length === 0) return new Map();
  const [residency, urls] = await Promise.all([
    loadResidency(signedFetch, subKeys),
    options.urls === false ? Promise.resolve(new Map<string, string>()) : loadRenditionUrls(signedFetch, subKeys),
  ]);
  const out = new Map<string, HydratedRendition[]>();
  for (const [parentId, list] of rows) {
    out.set(
      parentId,
      list.map((row) => {
        const url = urls.get(row.sub_key);
        return {
          ...row,
          availableHere: residency.get(row.sub_key) ?? false,
          ...(url ? { url } : {}),
        };
      }),
    );
  }
  return out;
}

/**
 * Write one rung's row.
 *
 * An upsert on `(parent_record_id, size_class)`. A second derivation of a rung
 * therefore replaces the row rather than minting a second one, which is what
 * makes the duplicate-child problem unrepresentable rather than merely
 * detected.
 */
export async function putRenditionRow(
  signedFetch: SignedFetch,
  row: RenditionRow,
): Promise<void> {
  const res = await signedFetch(`/app-data/db/${RENDITIONS_TABLE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ row }),
  });
  if (!res.ok) await fail("write", res);
}

/** Forget one rung. The bytes are the reaper's to collect. */
export async function deleteRenditionRow(
  signedFetch: SignedFetch,
  parentRecordId: string,
  sizeClass: string,
): Promise<void> {
  const res = await signedFetch(`/app-data/db/${RENDITIONS_TABLE}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ where: { parent_record_id: parentRecordId, size_class: sizeClass } }),
  });
  if (!res.ok) await fail("delete", res);
}

/** Every rendition sub-key the app's file plane is holding a row for. */
export async function listRenditionBlobs(
  signedFetch: SignedFetch,
): Promise<Array<{ subKey: string; sizeBytes: number; resident: boolean }>> {
  const out: Array<{ subKey: string; sizeBytes: number; resident: boolean }> = [];
  let cursor: string | null = null;
  do {
    const path = cursor
      ? `/app-data/residency?cursor=${encodeURIComponent(cursor)}`
      : `/app-data/residency`;
    const res: Response = await signedFetch(path);
    if (!res.ok) return fail("residency page", res);
    const body = (await res.json()) as {
      entries?: Array<{ subKey: string; sizeBytes: number; resident: boolean }>;
      nextCursor?: string | null;
    };
    for (const entry of body.entries ?? []) {
      if (entry.subKey.startsWith(RENDITION_SUBKEY_PREFIX)) out.push(entry);
    }
    cursor = body.nextCursor ?? null;
  } while (cursor !== null);
  return out;
}

/** Delete a rendition file outright — row and bytes together. */
export async function deleteRenditionBlob(
  signedFetch: SignedFetch,
  subKey: string,
): Promise<void> {
  const res = await signedFetch(`/app-data/files/${subKey}`, { method: "DELETE" });
  if (!res.ok) await fail("delete blob", res);
}
