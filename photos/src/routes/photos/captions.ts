import { loadAppCredentials, signedFetch } from "@starkeep/app-client";

const MAX_CAPTION_LENGTH = 2000;

/**
 * Photos-owned caption API. The browser only sees `{caption}` shaped requests;
 * the underlying row shape and the `photos_syncable_image_enriched` table name
 * are internal to this app. The platform exposes `/app-data/db/image_enriched`
 * generically — we mediate it here so we can enforce caption length, scope every
 * request to a path-supplied image id, and keep the table schema an implementation
 * detail of the photos app.
 */

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

function notInstalled(): Response {
  return Response.json(
    { error: "photos has not been installed locally — run install from admin-web first" },
    { status: 503 },
  );
}

export async function GET(_req: Request, id: string): Promise<Response> {
  const creds = await loadAppCredentials("photos");
  if (!creds) return notInstalled();
  // Filters live under `where` as JSON. One row is expected, so the page is
  // asked for explicitly rather than left to the server's default.
  const q = new URLSearchParams({ where: JSON.stringify({ record_id: id }), limit: "1" });
  const upstream = await signedFetch(creds, `/app-data/db/image_enriched?${q.toString()}`);
  if (!upstream.ok) {
    return Response.json({ caption: null }, { status: upstream.status });
  }
  const { rows } = (await upstream.json()) as { rows?: Array<{ caption?: string | null }> };
  return Response.json({ caption: rows?.[0]?.caption ?? null });
}

export async function PUT(req: Request, id: string): Promise<Response> {
  const creds = await loadAppCredentials("photos");
  if (!creds) return notInstalled();
  const body = (await req.json().catch(() => null)) as { caption?: unknown } | null;
  if (!body || typeof body.caption !== "string") {
    return badRequest("caption (string) is required");
  }
  const caption = body.caption;
  if (caption.length > MAX_CAPTION_LENGTH) {
    return badRequest(`caption must be ≤ ${MAX_CAPTION_LENGTH} chars`);
  }

  // Empty string is treated as "remove the caption" — set to null rather than
  // deleting the row, as it may still hold title or date_taken_override data.
  const captionValue = caption === "" ? null : caption;

  // POST is a partial upsert: the platform injects a fresh updated_at so the
  // LWW conflict resolution always fires, and the ON CONFLICT SET clause only
  // covers columns present in the row (record_id, caption) — title and
  // date_taken_override are left untouched on existing rows.
  const insertRes = await signedFetch(creds, "/app-data/db/image_enriched", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ row: { record_id: id, caption: captionValue } }),
  });
  if (!insertRes.ok) {
    const errBody = await insertRes.text().catch(() => "");
    return Response.json({ error: errBody || "Failed to save caption" }, { status: 502 });
  }

  return Response.json({ caption: captionValue });
}

export async function DELETE(_req: Request, id: string): Promise<Response> {
  const creds = await loadAppCredentials("photos");
  if (!creds) return notInstalled();
  await signedFetch(creds, "/app-data/db/image_enriched", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ row: { record_id: id, caption: null } }),
  });
  return Response.json({ caption: null });
}
