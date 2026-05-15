import { type NextRequest, NextResponse } from "next/server";
import { loadLocalAppCredentials } from "../../../../../src/lib/local-app-creds";
import { signedFetch } from "../../../../../src/lib/data-server-fetch";

export const runtime = "nodejs";

const MAX_CAPTION_LENGTH = 2000;

/**
 * Photos-owned caption API. The browser only sees `{caption}` shaped requests;
 * the underlying row shape (`image_id`, `caption`, `updated_at`) and the
 * `photos_syncable_captions` table name are internal to this app. The platform
 * exposes `/app-data/db/captions` generically — we mediate it here so we can
 * enforce caption length, scope every request to a path-supplied image id, and
 * keep the table schema an implementation detail of the photos app.
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

function badRequest(message: string): Response {
  return NextResponse.json({ error: message }, { status: 400 });
}

function notInstalled(): Response {
  return NextResponse.json(
    { error: "photos has not been installed locally — run install from admin-web first" },
    { status: 503 },
  );
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<Response> {
  const creds = loadLocalAppCredentials();
  if (!creds) return notInstalled();
  const { id } = await ctx.params;
  const q = new URLSearchParams({ image_id: id });
  const upstream = await signedFetch(creds, `/app-data/db/captions?${q.toString()}`);
  if (!upstream.ok) {
    return NextResponse.json({ caption: null }, { status: upstream.status });
  }
  const { rows } = (await upstream.json()) as { rows?: Array<{ caption?: string }> };
  return NextResponse.json({ caption: rows?.[0]?.caption ?? null });
}

export async function PUT(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const creds = loadLocalAppCredentials();
  if (!creds) return notInstalled();
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { caption?: unknown } | null;
  if (!body || typeof body.caption !== "string") {
    return badRequest("caption (string) is required");
  }
  const caption = body.caption;
  if (caption.length > MAX_CAPTION_LENGTH) {
    return badRequest(`caption must be ≤ ${MAX_CAPTION_LENGTH} chars`);
  }

  // Empty string is treated as "remove the caption" — keeps the table free of
  // empty rows that would otherwise sync as noise.
  if (caption === "") {
    const deleteBody = JSON.stringify({ where: { image_id: id } });
    await signedFetch(creds, "/app-data/db/captions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: deleteBody,
    });
    return NextResponse.json({ caption: null });
  }

  const now = new Date().toISOString();
  // Upsert: try update first, fall back to insert if no row matched. Simpler
  // than INSERT … ON CONFLICT given the generic platform API.
  const updateBody = JSON.stringify({
    where: { image_id: id },
    patch: { caption, updated_at: now },
  });
  const updateRes = await signedFetch(creds, "/app-data/db/captions", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: updateBody,
  });
  if (updateRes.ok) {
    const { changes } = (await updateRes.json()) as { changes?: number };
    if ((changes ?? 0) > 0) return NextResponse.json({ caption });
  }
  const insertBody = JSON.stringify({
    row: { image_id: id, caption, updated_at: now },
  });
  const insertRes = await signedFetch(creds, "/app-data/db/captions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: insertBody,
  });
  if (!insertRes.ok) {
    const errBody = await insertRes.text().catch(() => "");
    return NextResponse.json({ error: errBody || "Failed to save caption" }, { status: 502 });
  }
  return NextResponse.json({ caption });
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<Response> {
  const creds = loadLocalAppCredentials();
  if (!creds) return notInstalled();
  const { id } = await ctx.params;
  await signedFetch(creds, "/app-data/db/captions", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ where: { image_id: id } }),
  });
  return NextResponse.json({ caption: null });
}
