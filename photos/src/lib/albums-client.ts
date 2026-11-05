/**
 * The browser's calls to Photos' album and public-link routes.
 *
 * Same-origin, through `withBasePath`, with the one refresh-and-retry every
 * Photos route gets (`fetchWithSession`). Each call throws with the server's
 * own message, so a dialog can show it as it is.
 */

import type { Album } from "@/photos-lib/client";
import { withBasePath } from "./base-path";
import { fetchWithSession } from "./data-client";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithSession(withBasePath(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `${path} failed: ${res.status}`);
  return body as T;
}

export async function listAlbums(): Promise<Album[]> {
  return (await call<{ albums: Album[] }>("/api/albums")).albums;
}

export async function createAlbum(title: string): Promise<Album> {
  return (
    await call<{ album: Album }>("/api/albums", { method: "POST", body: JSON.stringify({ title }) })
  ).album;
}

export async function updateAlbum(
  id: string,
  change: { title?: string; coverRecordId?: string | null },
): Promise<void> {
  await call(`/api/albums/${id}`, { method: "PATCH", body: JSON.stringify(change) });
}

export async function deleteAlbum(id: string): Promise<void> {
  await call(`/api/albums/${id}`, { method: "DELETE" });
}

export async function changeAlbumMembers(
  id: string,
  change: { add?: readonly string[]; remove?: readonly string[] },
): Promise<void> {
  await call(`/api/albums/${id}/members`, { method: "POST", body: JSON.stringify(change) });
}

/** A public link to an album, as the owner sees it. */
export interface PublicLink {
  readonly id: string;
  readonly albumId: string;
  readonly linkToken: string;
  readonly title: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number | null;
}

/** The lifetimes a person may choose, in the platform's spelling. */
export const LINK_LIFETIMES = [
  { value: "1d", label: "1 day" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "1y", label: "1 year" },
  { value: "never", label: "Never expires" },
] as const;

export type LinkLifetime = (typeof LINK_LIFETIMES)[number]["value"];

export const DEFAULT_LINK_LIFETIME: LinkLifetime = "30d";

/**
 * This person's links, or why there are none to show: a computer that is
 * signed out or offline cannot reach the cloud, where links live.
 * `viewerBaseUrl` is cloud Photos' address when this page is not cloud Photos.
 */
export type PublicLinksState =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      readonly mayPublish: boolean;
      readonly viewerBaseUrl: string | null;
      readonly links: readonly PublicLink[];
    };

export async function listPublicLinks(): Promise<PublicLinksState> {
  return call<PublicLinksState>("/api/public-links");
}

export async function createPublicLink(input: {
  albumId: string;
  title: string;
  lifetime: LinkLifetime;
}): Promise<PublicLink> {
  return (
    await call<{ link: PublicLink }>("/api/public-links", {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).link;
}

export async function updatePublicLink(
  id: string,
  change: { title?: string; lifetime?: LinkLifetime; rotateLink?: true },
): Promise<PublicLink> {
  return (
    await call<{ link: PublicLink }>(`/api/public-links/${id}`, {
      method: "PATCH",
      body: JSON.stringify(change),
    })
  ).link;
}

export async function deletePublicLink(id: string): Promise<void> {
  await call(`/api/public-links/${id}`, { method: "DELETE" });
}

/**
 * The URL a visitor opens: cloud Photos' `p/<token>`. On the desktop that is
 * `viewerBaseUrl`; in the cloud it is this page's origin and Photos' mount.
 */
export function publicLinkUrl(
  linkToken: string,
  viewerBaseUrl: string | null,
  origin: string = window.location.origin,
): string {
  if (viewerBaseUrl) return `${viewerBaseUrl.replace(/\/+$/, "")}/p/${linkToken}`;
  return `${origin}${withBasePath(`/p/${linkToken}`)}`;
}
