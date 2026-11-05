import { readFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { authorizePhotosRoute, withRefreshedSession } from "@/lib/photos-route-server";
import { isAlbumId, normalizeAlbumTitle } from "@/photos-lib/albums";
import { PHOTOS_LABEL_KEYS } from "@/photos-lib/labels";

/**
 * Public links to albums: thin mediations of the platform's public-share
 * routes, scoped to Photos' `album` label.
 *
 *   GET    /api/public-links                    this person's links, by album
 *   POST   /api/public-links  { albumId, title, lifetime }
 *   PATCH  /api/public-links/:id  { title?, lifetime?, rotateLink? }
 *   DELETE /api/public-links/:id                stop sharing
 *
 * The same calls in both modes. Shares live in the cloud alone: cloud Photos
 * reaches the cloud's routes directly, and on the desktop the local data
 * server forwards `/data/public-shares` to the cloud with this computer's
 * sign-in. So a link needs the cloud to be reachable, while albums
 * themselves stay local-first.
 *
 * The platform owns every rule that matters — who may create a link, what a
 * visitor sees, the lifetimes — and checks them on each call. What this adds
 * is the album: the browser names an album, never a label.
 */

const CLOUD = () => process.env.STARKEEP_APP_CLIENT_MODE === "cloud";

/**
 * Where cloud Photos lives, read from the machine's own
 * `~/.starkeep/config.json`, which holds the cloud's address once the machine
 * has one: the CloudFront address when known, else the gateway's. Null on a
 * machine with no cloud.
 */
export function cloudPhotosUrl(read: (path: string) => string = (p) => readFileSync(p, "utf8")): string | null {
  try {
    const config = JSON.parse(read(join(starkeepDir(), "config.json"))) as {
      publicBaseUrl?: unknown;
      apiGatewayUrl?: unknown;
    };
    const base = [config.publicBaseUrl, config.apiGatewayUrl].find(
      (v): v is string => typeof v === "string" && /^https:\/\//.test(v),
    );
    return base ? `${base.replace(/\/+$/, "")}/apps/photos/` : null;
  } catch {
    return null;
  }
}

/**
 * Where a visitor opens a link: cloud Photos' address on the desktop, whose
 * own origin is this computer. Null in the cloud, where the page's origin is
 * already cloud Photos.
 */
function viewerBaseUrl(): string | null {
  return CLOUD() ? null : cloudPhotosUrl();
}

interface PlatformShare {
  id: string;
  linkToken: string;
  labelKey: string;
  labelValue: string;
  title: string;
  createdAtMs: number;
  expiresAtMs: number | null;
}

/** A platform share as the browser sees it: the album, not the label. */
function linkView(share: PlatformShare) {
  return {
    id: share.id,
    albumId: share.labelValue,
    linkToken: share.linkToken,
    title: share.title,
    createdAtMs: share.createdAtMs,
    expiresAtMs: share.expiresAtMs,
  };
}

async function passError(res: Response): Promise<Response> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return Response.json({ error: body?.error ?? `Request failed: ${res.status}` }, { status: res.status });
}

export async function GET(req: Request): Promise<Response> {
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;
  const res = await authorized.fetch("/data/public-shares");
  if (!res.ok) {
    // Signed out, offline, or a cloud that refused: the dialog shows why, and
    // the albums work on without links.
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return withRefreshedSession(
      Response.json({
        available: false,
        reason: body?.error ?? `Public links are unavailable (${res.status})`,
      }),
      authorized.refreshedCookie,
    );
  }
  const body = (await res.json()) as { publicShares: PlatformShare[]; mayPublish: boolean };
  return withRefreshedSession(
    Response.json({
      available: true,
      mayPublish: body.mayPublish,
      viewerBaseUrl: viewerBaseUrl(),
      links: body.publicShares.filter((s) => s.labelKey === PHOTOS_LABEL_KEYS.album).map(linkView),
    }),
    authorized.refreshedCookie,
  );
}

export async function POST(req: Request): Promise<Response> {
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;
  const body = (await req.json().catch(() => null)) as {
    albumId?: unknown;
    title?: unknown;
    lifetime?: unknown;
  } | null;
  if (!isAlbumId(body?.albumId)) return Response.json({ error: "albumId is required" }, { status: 400 });
  const title = normalizeAlbumTitle(body?.title);
  if (title === null) return Response.json({ error: "title must be 1 to 200 characters" }, { status: 400 });
  const res = await authorized.fetch("/data/public-shares", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      labelKey: PHOTOS_LABEL_KEYS.album,
      labelValue: body!.albumId,
      title,
      lifetime: body?.lifetime,
    }),
  });
  if (!res.ok) return passError(res);
  const { publicShare } = (await res.json()) as { publicShare: PlatformShare };
  return withRefreshedSession(
    Response.json({ link: linkView(publicShare) }, { status: 201 }),
    authorized.refreshedCookie,
  );
}

const SHARE_ID = /^[0-9a-f-]{36}$/;

export async function PATCH(req: Request, id: string): Promise<Response> {
  if (!SHARE_ID.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "Body is not JSON" }, { status: 400 });
  const change: Record<string, unknown> = {};
  if (body.title !== undefined) change.title = body.title;
  if (body.lifetime !== undefined) change.lifetime = body.lifetime;
  if (body.rotateLink === true) change.rotateLink = true;
  const res = await authorized.fetch(`/data/public-shares/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
  });
  if (!res.ok) return passError(res);
  const { publicShare } = (await res.json()) as { publicShare: PlatformShare };
  return withRefreshedSession(Response.json({ link: linkView(publicShare) }), authorized.refreshedCookie);
}

export async function DELETE(req: Request, id: string): Promise<Response> {
  if (!SHARE_ID.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;
  const res = await authorized.fetch(`/data/public-shares/${id}`, { method: "DELETE" });
  if (!res.ok) return passError(res);
  return withRefreshedSession(Response.json({ deleted: id }), authorized.refreshedCookie);
}
