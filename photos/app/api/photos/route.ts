import { type NextRequest, NextResponse } from "next/server";
import { loadAppCredentials, signedFetch } from "@starkeep/app-client";
import { photoRecordToAppImage } from "../../../src/lib/photoRecordToAppImage";
import type { PhotoRecord, PhotoMetadataRow, ImageEnriched } from "../../../src/lib/data-server-client";

export const runtime = "nodejs";

function notInstalled(): Response {
  return NextResponse.json(
    { error: "photos has not been installed locally — run install from admin-web first" },
    { status: 503 },
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  const creds = await loadAppCredentials("photos");
  if (!creds) return notInstalled();

  const cursor = req.nextUrl.searchParams.get("cursor") ?? undefined;
  // No `type` filter: the server scopes a type-less query to the app's granted
  // extensions (the image extensions), so this lists all images in one call.
  const qs = new URLSearchParams({ limit: "50" });
  if (cursor) qs.set("updated_after", cursor);

  const recordsRes = await signedFetch(creds, `/data/records?${qs.toString()}`);
  if (!recordsRes.ok) {
    const errBody = await recordsRes.text().catch(() => "");
    return NextResponse.json({ error: `Failed to fetch records: ${errBody}` }, { status: 502 });
  }
  const { records } = (await recordsRes.json()) as { records: PhotoRecord[] };

  // Fetch shared metadata and user metadata in parallel for all records.
  const [metaResults, userMetaResults] = await Promise.all([
    Promise.all(
      records.map(async (r): Promise<PhotoMetadataRow | null> => {
        const metaRes = await signedFetch(creds, `/data/records/${r.id}/metadata/image`);
        if (!metaRes.ok) return null;
        const { metadata } = (await metaRes.json()) as { metadata: PhotoMetadataRow | null };
        return metadata;
      }),
    ),
    Promise.all(
      records.map(async (r): Promise<ImageEnriched | null> => {
        // Thumbnails (parent_id !== null) don't have enriched metadata.
        if (r.parent_id !== null) return null;
        const q = new URLSearchParams({ record_id: r.id });
        const umRes = await signedFetch(creds, `/app-data/db/image_enriched?${q.toString()}`);
        if (!umRes.ok) return null;
        const { rows } = (await umRes.json()) as { rows?: ImageEnriched[] };
        return rows?.[0] ?? null;
      }),
    ),
  ]);

  const images = records.map((r, i) =>
    photoRecordToAppImage(r, metaResults[i] ?? null, userMetaResults[i] ?? null),
  );

  const lastRecord = records[records.length - 1];
  const nextCursor = records.length === 50 && lastRecord ? lastRecord.updated_at : null;

  return NextResponse.json({ images, nextCursor });
}
