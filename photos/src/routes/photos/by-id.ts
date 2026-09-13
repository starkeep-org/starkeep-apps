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

export async function DELETE(_req: Request, id: string): Promise<Response> {
  const creds = await loadAppCredentials("photos");
  if (!creds) return notInstalled();

  const deleteRes = await signedFetch(creds, `/data/records/${id}`, { method: "DELETE" });
  if (!deleteRes.ok) {
    const errBody = await deleteRes.text().catch(() => "");
    return Response.json({ error: `Delete failed: ${errBody}` }, { status: deleteRes.status });
  }
  return Response.json({ ok: true });
}
