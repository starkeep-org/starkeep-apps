import { type NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { loadLocalAppCredentials } from "../../../src/lib/local-app-creds";
import { signedFetch } from "../../../src/lib/data-server-fetch";
import { photoRecordToAppImage } from "../../../src/lib/photoRecordToAppImage";
import type { PhotoRecord, PhotoMetadataRow, ImageEnriched } from "../../../src/lib/data-server-client";
import { extractExif } from "../../../src/photos-lib/metadata/exif-reader";
import { extensionFromFilename } from "../../../src/lib/file-extension";

// shared/<typeId>/<shard>/<contentHash> — mirrors dataRecordObjectKey in
// @starkeep/core/storage/object-keys. Inlined here to keep this route a
// thin Next runtime layer without dragging the core package into the
// browser-adjacent build.
function dataRecordObjectKey(typeId: string, contentHash: string): string {
  return `shared/${typeId}/${contentHash.slice(0, 2)}/${contentHash}`;
}

export const runtime = "nodejs";

function notInstalled(): Response {
  return NextResponse.json(
    { error: "photos has not been installed locally — run install from admin-web first" },
    { status: 503 },
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  const creds = loadLocalAppCredentials();
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

export async function POST(req: NextRequest): Promise<Response> {
  const creds = loadLocalAppCredentials();
  if (!creds) return notInstalled();

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  const originalFilename = (formData.get("originalFilename") as string | null) ?? "upload";
  const title = formData.get("title") as string | null;
  const caption = formData.get("caption") as string | null;
  const mimeType = file.type || "image/jpeg";
  const fileBytes = Buffer.from(await file.arrayBuffer());

  // Extract EXIF and dimensions concurrently.
  const [exif, sharp] = await Promise.all([
    extractExif(fileBytes),
    import("sharp").then((m) => m.default),
  ]);

  let width = 0;
  let height = 0;
  try {
    const meta = await (sharp as typeof import("sharp"))(fileBytes).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } catch {}

  // Upload via presigned S3 PUT, then register the record by content hash.
  // The inline /data/records form base64-wraps bytes into the JSON body,
  // which API Gateway caps at 10 MB. A 7 MB photo is ~9.7 MB once encoded —
  // so the inline path 413s on real photos.
  const contentHash = createHash("sha256").update(fileBytes).digest("hex");
  const objectStorageKey = dataRecordObjectKey("image", contentHash);

  const presignRes = await signedFetch(creds, "/files/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: objectStorageKey, contentType: mimeType }),
  });
  if (!presignRes.ok) {
    const errBody = await presignRes.text().catch(() => "");
    return NextResponse.json({ error: `Failed to presign upload: ${errBody}` }, { status: 502 });
  }
  const { url: uploadUrl } = (await presignRes.json()) as { url: string };

  const s3Res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: fileBytes,
  });
  if (!s3Res.ok) {
    return NextResponse.json(
      { error: `S3 PUT failed: ${s3Res.status} ${s3Res.statusText}` },
      { status: 502 },
    );
  }

  const createRes = await signedFetch(creds, "/data/records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: extensionFromFilename(originalFilename),
      fileName: originalFilename,
      contentType: mimeType,
      contentHash,
      sizeBytes: fileBytes.length,
    }),
  });
  if (!createRes.ok) {
    const errBody = await createRes.text().catch(() => "");
    return NextResponse.json({ error: `Failed to create record: ${errBody}` }, { status: 502 });
  }
  const { record, deduped } = (await createRes.json()) as { record: PhotoRecord; deduped?: boolean };

  // Write EXIF + dimensions into shared image metadata.
  const rawMeta: Record<string, unknown> = { width, height };
  const exifMap: Record<string, unknown> = {
    captured_at: exif.dateTakenRaw,
    camera_make: exif.cameraMake,
    camera_model: exif.cameraModel,
    f_number: exif.fNumber,
    exposure_time: exif.exposureTime,
    iso: exif.iso,
    lens_model: exif.lensModel,
    gps_lat: exif.gpsLat,
    gps_lon: exif.gpsLon,
    orientation: exif.orientation,
  };
  for (const [k, v] of Object.entries(exifMap)) {
    if (v !== null && v !== undefined) rawMeta[k] = v;
  }
  const metaRes = await signedFetch(creds, `/data/records/${record.id}/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ typeId: "image", metadata: rawMeta }),
  });

  const photoMeta: PhotoMetadataRow | null = metaRes.ok
    ? {
        recordId: record.id,
        width,
        height,
        captured_at: exif.dateTakenRaw,
        camera_make: exif.cameraMake,
        camera_model: exif.cameraModel,
        f_number: exif.fNumber,
        exposure_time: exif.exposureTime,
        iso: exif.iso,
        lens_model: exif.lensModel,
        gps_lat: exif.gpsLat,
        gps_lon: exif.gpsLon,
        orientation: exif.orientation,
      }
    : null;

  const now = new Date().toISOString();

  // Write enriched metadata (title, caption) to image_enriched as a single row.
  if (title || caption) {
    const enrichedRow: Record<string, unknown> = { record_id: record.id, updated_at: now };
    if (title) enrichedRow.title = title;
    if (caption) enrichedRow.caption = caption;
    await signedFetch(creds, "/app-data/db/image_enriched", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: enrichedRow }),
    });
  }

  // Thumbnail generation is driven by the UI's orphan-backfill effect (see
  // photos-app.tsx), which fires /api/resize for any original lacking a
  // thumbnail. We deliberately do NOT also fire it here: two concurrent
  // triggers for the same upload would both pass the resize route's
  // check-then-create dedup and register duplicate thumbnails.

  const enriched: ImageEnriched | null = (title || caption) ? { title, caption } : null;
  // Duplicate uploads (same filename + same bytes) are surfaced by the
  // data-server as `deduped: true` alongside the existing record. We pass
  // that signal up so the UI can tell the user nothing new was added.
  return NextResponse.json(
    { image: photoRecordToAppImage(record, photoMeta, enriched), deduped: deduped === true },
    { status: deduped ? 200 : 201 },
  );
}
