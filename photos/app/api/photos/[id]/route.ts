import { type NextRequest, NextResponse } from "next/server";
import { loadLocalAppCredentials } from "../../../../src/lib/local-app-creds";
import { signedFetch } from "../../../../src/lib/data-server-fetch";
import { photoRecordToAppImage } from "../../../../src/lib/photoRecordToAppImage";
import type { PhotoRecord, PhotoMetadataRow, ImageEnriched } from "../../../../src/lib/data-server-client";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function notInstalled(): Response {
  return NextResponse.json(
    { error: "photos has not been installed locally — run install from admin-web first" },
    { status: 503 },
  );
}

async function fetchAssembledImage(
  creds: Awaited<ReturnType<typeof import("../../../../src/lib/local-app-creds").loadLocalAppCredentials>>,
  id: string,
) {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const [recordRes, metaRes] = await Promise.all([
    signedFetch(creds!, `/data/records/${id}`),
    signedFetch(creds!, `/data/records/${id}/metadata/image`),
  ]);

  if (!recordRes.ok) return null;
  const { record } = (await recordRes.json()) as { record: PhotoRecord };

  const metadata: PhotoMetadataRow | null = metaRes.ok
    ? ((await metaRes.json()) as { metadata: PhotoMetadataRow | null }).metadata
    : null;

  let enriched: ImageEnriched | null = null;
  if (record.parent_id === null) {
    const q = new URLSearchParams({ record_id: id });
    const umRes = await signedFetch(creds!, `/app-data/db/image_enriched?${q.toString()}`);
    if (umRes.ok) {
      const { rows } = (await umRes.json()) as { rows?: ImageEnriched[] };
      enriched = rows?.[0] ?? null;
    }
  }

  return photoRecordToAppImage(record, metadata, enriched);
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<Response> {
  const creds = loadLocalAppCredentials();
  if (!creds) return notInstalled();
  const { id } = await ctx.params;
  const image = await fetchAssembledImage(creds, id);
  if (!image) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ image });
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const creds = loadLocalAppCredentials();
  if (!creds) return notInstalled();
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => null)) as {
    title?: string | null;
    dateTakenOverride?: string | null;
    caption?: string;
  } | null;
  if (!body) return NextResponse.json({ error: "JSON body required" }, { status: 400 });

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
  if (!image) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ image });
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<Response> {
  const creds = loadLocalAppCredentials();
  if (!creds) return notInstalled();
  const { id } = await ctx.params;

  const deleteRes = await signedFetch(creds, `/data/records/${id}`, { method: "DELETE" });
  if (!deleteRes.ok) {
    const errBody = await deleteRes.text().catch(() => "");
    return NextResponse.json({ error: `Delete failed: ${errBody}` }, { status: deleteRes.status });
  }
  return NextResponse.json({ ok: true });
}
