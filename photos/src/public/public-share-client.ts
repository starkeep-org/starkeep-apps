/**
 * The one request a public-share visitor's page makes: a page of items.
 *
 * `/public-shares/<token>/items` lives at the deployment's root, not under
 * Photos' mount, because the platform serves it: the cloud data server owns
 * the anonymous read and CloudFront caches it for a minute. So this path
 * deliberately does not go through `withBasePath`. Nothing here sends a
 * cookie or a credential, and the page imports none of the signed-in app's
 * data code.
 */

/** One display file, ascending by long edge. */
export interface PublicSize {
  readonly longEdge: number;
  readonly url: string;
}

/** One photo or video as a visitor sees it. */
export interface PublicItem {
  readonly id: string;
  readonly category: "image" | "video";
  readonly width: number;
  readonly height: number;
  readonly sizes: readonly PublicSize[];
  readonly playback: { readonly url: string; readonly type: string } | null;
}

export interface PublicPage {
  readonly title: string;
  /** An album's link names a label; a photo's link names one record. */
  readonly source: "label" | "record";
  readonly items: readonly PublicItem[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}

export type PublicPageResult =
  | { readonly ok: true; readonly page: PublicPage }
  | { readonly ok: false; readonly reason: "expired" | "gone" | "failed" };

/** The link token a visitor's path names, or null. */
export function linkTokenOf(appRelativePath: string): string | null {
  const m = /^\/p\/([A-Za-z0-9_-]{22})\/?$/.exec(appRelativePath);
  return m ? m[1]! : null;
}

export function itemsUrl(linkToken: string, cursor: string | null): string {
  const base = `/public-shares/${encodeURIComponent(linkToken)}/items`;
  return cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
}

export async function fetchPublicPage(
  linkToken: string,
  cursor: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicPageResult> {
  const url = itemsUrl(linkToken, cursor);
  let res: Response;
  try {
    res = await fetchImpl(url, { credentials: "omit", referrerPolicy: "no-referrer" });
  } catch {
    return { ok: false, reason: "failed" };
  }
  if (res.status === 410) return { ok: false, reason: "expired" };
  if (res.status === 404) return { ok: false, reason: "gone" };
  if (!res.ok) return { ok: false, reason: "failed" };
  return { ok: true, page: (await res.json()) as PublicPage };
}

/** The smallest size at least `px` on its long edge, or the largest there is. */
export function sizeFor(sizes: readonly PublicSize[], px: number): PublicSize | null {
  return sizes.find((s) => s.longEdge >= px) ?? sizes[sizes.length - 1] ?? null;
}
