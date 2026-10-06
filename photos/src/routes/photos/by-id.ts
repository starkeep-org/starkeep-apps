import { type AppCredentials, loadAppCredentials, signedFetch } from "@starkeep/app-client";
import { photoRecordToAppImage } from "@/lib/photoRecordToAppImage";
import type { PhotoRecord, PhotoMetadataRow, ImageEnriched } from "@/lib/data-server-client";

function notInstalled(): Response {
  return Response.json(
    { error: "photos has not been installed locally — run install from admin-web first" },
    { status: 503 },
  );
}

async function fetchAssembledImage(
  creds: AppCredentials,
  id: string,
) {
  const [recordRes, metaRes] = await Promise.all([
    signedFetch(creds, `/data/records/${id}`),
    signedFetch(creds, `/data/records/${id}/metadata/image`),
  ]);

  if (!recordRes.ok) return null;
  const { record } = (await recordRes.json()) as { record: PhotoRecord };

  const metadata: PhotoMetadataRow | null = metaRes.ok
    ? ((await metaRes.json()) as { metadata: PhotoMetadataRow | null }).metadata
    : null;

  let enriched: ImageEnriched | null = null;
  if (record.parent_id === null) {
    const q = new URLSearchParams({ where: JSON.stringify({ record_id: id }), limit: "1" });
    const umRes = await signedFetch(creds, `/app-data/db/image_enriched?${q.toString()}`);
    if (umRes.ok) {
      const { rows } = (await umRes.json()) as { rows?: ImageEnriched[] };
      enriched = rows?.[0] ?? null;
    }
  }

  return photoRecordToAppImage(record, metadata, enriched);
}

export async function GET(_req: Request, id: string): Promise<Response> {
  const creds = await loadAppCredentials("photos");
  if (!creds) return notInstalled();
  const image = await fetchAssembledImage(creds, id);
  if (!image) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ image });
}

export async function PATCH(req: Request, id: string): Promise<Response> {
  const creds = await loadAppCredentials("photos");
  if (!creds) return notInstalled();

  const body = (await req.json().catch(() => null)) as {
    title?: string | null;
    dateTakenOverride?: string | null;
    caption?: string;
  } | null;
  if (!body) return Response.json({ error: "JSON body required" }, { status: 400 });

  const { title, dateTakenOverride, caption } = body;

  if (title !== undefined || dateTakenOverride !== undefined || caption !== undefined) {
    const row: Record<string, unknown> = { record_id: id };
    if (title !== undefined) row.title = title;
    if (dateTakenOverride !== undefined) row.date_taken_override = dateTakenOverride;
    if (caption !== undefined) row.caption = caption === "" ? null : caption;
    await signedFetch(creds, "/app-data/db/image_enriched", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row }),
    });
  }

  const image = await fetchAssembledImage(creds, id);
  if (!image) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ image });
}

/**
 * Delete a photograph: the shared record, and this app's own row about it.
 *
 * The platform deletes the record, its stand-ins, its derived children and every
 * app's labels on any of them, because the item is going away. It does not touch an
 * app's private table — it cannot know which rows of yours refer to a record — so
 * `image_enriched` is this route's to clean up, and it was being left behind.
 *
 * The record goes first, and the row after. A failed record delete leaves the row
 * where it is, which is the harmless half: the row is keyed by `record_id` and
 * nothing reads it without the record. The other order would strand an edit if the
 * delete were refused.
 *
 * A failed row delete does not fail the request. The photograph is gone as far as
 * the person is concerned, and the orphan is recoverable through the delete feed —
 * `deleted=only&updated_after=` names exactly the records whose rows to drop.
 */
export async function DELETE(_req: Request, id: string): Promise<Response> {
  const creds = await loadAppCredentials("photos");
  if (!creds) return notInstalled();

  const deleteRes = await signedFetch(creds, `/data/records/${id}`, { method: "DELETE" });
  if (!deleteRes.ok) {
    const errBody = await deleteRes.text().catch(() => "");
    return Response.json({ error: `Delete failed: ${errBody}` }, { status: deleteRes.status });
  }

  const rowRes = await signedFetch(creds, "/app-data/db/image_enriched", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ where: { record_id: id } }),
  }).catch(() => null);
  if (!rowRes?.ok) {
    console.warn(
      `[photos] deleted record ${id} but could not drop its image_enriched row` +
        `${rowRes ? ` (${rowRes.status})` : ""}; it will be orphaned until a reconcile`,
    );
  }

  return Response.json({ ok: true });
}
