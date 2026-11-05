import { authorizePhotosRoute, withRefreshedSession, type AuthorizedPhotosFetch } from "@/lib/photos-route-server";
import {
  albumsFromRows,
  chunk,
  isAlbumId,
  newAlbumId,
  normalizeAlbumTitle,
  type AlbumRow,
} from "@/photos-lib/albums";
import { PHOTOS_LABEL_KEYS } from "@/photos-lib/labels";

/**
 * Photos' album routes. The browser sees albums and members; the table name,
 * its row shape and the label key stay internal to this app.
 *
 *   GET    /api/albums                      every live album
 *   POST   /api/albums           { title }  create one
 *   PATCH  /api/albums/:id       { title?, coverRecordId? }
 *   DELETE /api/albums/:id                  retract every member, then mark it deleted
 *   POST   /api/albums/:id/members         { add?: ids, remove?: ids }
 *
 * The album row lives in Photos' syncable `albums` table, through
 * `/app-data/db/albums`; membership is the `photos/album` label on each
 * original, through `/data/labels` and `/data/labels/retract`. Both are
 * local-first: on the desktop they write the local data server and sync
 * later, so albums work offline.
 *
 * A deleted album keeps its row with `deleted` set, rather than losing it,
 * so a device that syncs later learns the album is gone instead of bringing
 * it back. Deleting an album never deletes a photo.
 */

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

async function upstreamError(res: Response, what: string): Promise<Response> {
  const text = await res.text().catch(() => "");
  return Response.json({ error: `${what}: ${text || res.status}` }, { status: 502 });
}

/**
 * The data server's largest page. A read helper pages up to it until the
 * server has no more.
 */
const PAGE_LIMIT = 500;

/**
 * A read's outcome: the rows, or the error to answer with. Tagged rather than
 * checked with `instanceof Response`, because `@hono/node-server` replaces the
 * global `Response` locally and `Response.json` then builds an object that
 * fails that check.
 */
type Read<T> = { ok: true; value: T } | { ok: false; error: Response };

async function readAlbumRows(authorized: AuthorizedPhotosFetch): Promise<Read<AlbumRow[]>> {
  const rows: AlbumRow[] = [];
  let pageToken: string | null = null;
  do {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (pageToken) params.set("page_token", pageToken);
    const res = await authorized.fetch(`/app-data/db/albums?${params.toString()}`);
    if (!res.ok) return { ok: false, error: await upstreamError(res, "Failed to read albums") };
    const page = (await res.json()) as { rows?: AlbumRow[]; page_token?: string | null };
    rows.push(...(page.rows ?? []));
    pageToken = page.page_token ?? null;
  } while (pageToken);
  return { ok: true, value: rows };
}

async function writeAlbumRow(
  authorized: AuthorizedPhotosFetch,
  row: Record<string, unknown>,
): Promise<Response | null> {
  // A partial upsert: the platform stamps a fresh updated_at and sets only
  // the columns present, as the caption route relies on.
  const res = await authorized.fetch("/app-data/db/albums", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ row }),
  });
  return res.ok ? null : upstreamError(res, "Failed to save the album");
}

export async function GET(req: Request): Promise<Response> {
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;
  const rows = await readAlbumRows(authorized);
  if (!rows.ok) return rows.error;
  return withRefreshedSession(
    Response.json({ albums: albumsFromRows(rows.value) }),
    authorized.refreshedCookie,
  );
}

export async function POST(req: Request): Promise<Response> {
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;
  const body = (await req.json().catch(() => null)) as { title?: unknown } | null;
  const title = normalizeAlbumTitle(body?.title);
  if (title === null) return badRequest("title must be 1 to 200 characters");
  const album = { id: newAlbumId(), title, coverRecordId: null, createdAtMs: Date.now() };
  const failed = await writeAlbumRow(authorized, {
    album_id: album.id,
    title,
    cover_record_id: null,
    created_at_ms: album.createdAtMs,
    deleted: false,
  });
  if (failed) return failed;
  return withRefreshedSession(Response.json({ album }, { status: 201 }), authorized.refreshedCookie);
}

export async function PATCH(req: Request, id: string): Promise<Response> {
  if (!isAlbumId(id)) return badRequest("Not an album id");
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;
  const body = (await req.json().catch(() => null)) as {
    title?: unknown;
    coverRecordId?: unknown;
  } | null;
  if (!body) return badRequest("Body is not JSON");
  const row: Record<string, unknown> = { album_id: id };
  if (body.title !== undefined) {
    const title = normalizeAlbumTitle(body.title);
    if (title === null) return badRequest("title must be 1 to 200 characters");
    row.title = title;
  }
  if (body.coverRecordId !== undefined) {
    if (body.coverRecordId !== null && typeof body.coverRecordId !== "string") {
      return badRequest("coverRecordId must be a record id or null");
    }
    row.cover_record_id = body.coverRecordId;
  }
  if (Object.keys(row).length === 1) return badRequest("Nothing to change");
  const failed = await writeAlbumRow(authorized, row);
  if (failed) return failed;
  return withRefreshedSession(Response.json({ ok: true }), authorized.refreshedCookie);
}

/** Every record carrying the album's label, from the reverse index, paged to the end. */
async function memberIds(authorized: AuthorizedPhotosFetch, id: string): Promise<Read<string[]>> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({
      label: `photos/${PHOTOS_LABEL_KEYS.album}`,
      labelValue: id,
      limit: String(PAGE_LIMIT),
    });
    if (cursor) params.set("page_token", cursor);
    const res = await authorized.fetch(`/data/records?${params.toString()}`);
    if (!res.ok) return { ok: false, error: await upstreamError(res, "Failed to list the album") };
    const page = (await res.json()) as { records: Array<{ id: string }>; nextCursor?: string | null };
    for (const r of page.records) ids.push(r.id);
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return { ok: true, value: ids };
}

async function changeMembers(
  authorized: AuthorizedPhotosFetch,
  id: string,
  path: "/data/labels" | "/data/labels/retract",
  recordIds: readonly string[],
): Promise<Response | null> {
  for (const batch of chunk(recordIds)) {
    const res = await authorized.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        labels: batch.map((recordId) => ({ recordId, key: PHOTOS_LABEL_KEYS.album, value: id })),
      }),
    });
    if (!res.ok) return upstreamError(res, "Failed to change the album");
  }
  return null;
}

export async function DELETE(req: Request, id: string): Promise<Response> {
  if (!isAlbumId(id)) return badRequest("Not an album id");
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;
  // Members first, so a failure part way leaves an album the person can still
  // see and delete again, rather than labels pointing at a deleted album.
  const ids = await memberIds(authorized, id);
  if (!ids.ok) return ids.error;
  const retractFailed = await changeMembers(authorized, id, "/data/labels/retract", ids.value);
  if (retractFailed) return retractFailed;
  const failed = await writeAlbumRow(authorized, { album_id: id, deleted: true });
  if (failed) return failed;
  return withRefreshedSession(
    Response.json({ deleted: id, removed: ids.value.length }),
    authorized.refreshedCookie,
  );
}

function recordIdList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.length === 0)) return null;
  return [...new Set(value as string[])];
}

export async function POST_MEMBERS(req: Request, id: string): Promise<Response> {
  if (!isAlbumId(id)) return badRequest("Not an album id");
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;
  const body = (await req.json().catch(() => null)) as { add?: unknown; remove?: unknown } | null;
  const add = recordIdList(body?.add);
  const remove = recordIdList(body?.remove);
  if (add === null || remove === null) return badRequest("add and remove must be lists of record ids");
  if (add.length === 0 && remove.length === 0) return badRequest("Nothing to change");
  const addFailed = await changeMembers(authorized, id, "/data/labels", add);
  if (addFailed) return addFailed;
  const removeFailed = await changeMembers(authorized, id, "/data/labels/retract", remove);
  if (removeFailed) return removeFailed;
  return withRefreshedSession(
    Response.json({ added: add.length, removed: remove.length }),
    authorized.refreshedCookie,
  );
}
