import { type NextRequest, NextResponse } from "next/server";
import { loadLocalAppCredentials } from "../../../../src/lib/local-app-creds";
import { signedFetch } from "../../../../src/lib/data-server-fetch";
import { photoRecordToAppImage } from "../../../../src/lib/photoRecordToAppImage";
import type { PhotoRecord, PhotoMetadataRow, PhotoUserMetadata } from "../../../../src/lib/data-server-client";

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

  let userMeta: PhotoUserMetadata | null = null;
  if (record.parent_id === null) {
    const q = new URLSearchParams({ record_id: id });
    const umRes = await signedFetch(creds!, `/app-data/db/photos_user_metadata?${q.toString()}`);
    if (umRes.ok) {
      const { rows } = (await umRes.json()) as { rows?: PhotoUserMetadata[] };
      userMeta = rows?.[0] ?? null;
    }
  }

  return photoRecordToAppImage(record, metadata, userMeta);
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
  const now = new Date().toISOString();

  const tasks: Promise<unknown>[] = [];

  // Update user metadata (title / dateTakenOverride) via photos_user_metadata table.
  if (title !== undefined || dateTakenOverride !== undefined) {
    const patch: Record<string, unknown> = { updated_at: now };
    if (title !== undefined) patch.title = title;
    if (dateTakenOverride !== undefined) patch.date_taken_override = dateTakenOverride;

    const updateBody = JSON.stringify({ where: { record_id: id }, patch });
    const upsert = signedFetch(creds, "/app-data/db/photos_user_metadata", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: updateBody,
    }).then(async (updateRes) => {
      if (updateRes.ok) {
        const { changes } = (await updateRes.json()) as { changes?: number };
        if ((changes ?? 0) > 0) return;
      }
      // No existing row — insert.
      const row: Record<string, unknown> = { record_id: id, updated_at: now };
      if (title !== undefined) row.title = title;
      if (dateTakenOverride !== undefined) row.date_taken_override = dateTakenOverride;
      await signedFetch(creds, "/app-data/db/photos_user_metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row }),
      });
    });
    tasks.push(upsert);
  }

  // Update caption via the captions table.
  if (caption !== undefined) {
    const captionTask =
      caption === ""
        ? signedFetch(creds, "/app-data/db/captions", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ where: { image_id: id } }),
          })
        : signedFetch(creds, "/app-data/db/captions", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ where: { image_id: id }, patch: { caption, updated_at: now } }),
          }).then(async (updateRes) => {
            if (updateRes.ok) {
              const { changes } = (await updateRes.json()) as { changes?: number };
              if ((changes ?? 0) > 0) return;
            }
            await signedFetch(creds, "/app-data/db/captions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ row: { image_id: id, caption, updated_at: now } }),
            });
          });
    tasks.push(captionTask);
  }

  await Promise.all(tasks);

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
