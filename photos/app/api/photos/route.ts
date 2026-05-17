import { type NextRequest, NextResponse } from "next/server";
import { loadLocalAppCredentials } from "../../../src/lib/local-app-creds";
import { signedFetch } from "../../../src/lib/data-server-fetch";
import { photoRecordToAppImage } from "../../../src/lib/photoRecordToAppImage";
import type { PhotoRecord, PhotoMetadataRow, PhotoUserMetadata } from "../../../src/lib/data-server-client";
import { extractExif } from "../../../src/photos-lib/metadata/exif-reader";

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
  const qs = new URLSearchParams({ type: "image", limit: "50" });
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
      records.map(async (r): Promise<PhotoUserMetadata | null> => {
        // Thumbnails (parent_id !== null) don't have user metadata.
        if (r.parent_id !== null) return null;
        const q = new URLSearchParams({ record_id: r.id });
        const umRes = await signedFetch(creds, `/app-data/db/photos_user_metadata?${q.toString()}`);
        if (!umRes.ok) return null;
        const { rows } = (await umRes.json()) as { rows?: PhotoUserMetadata[] };
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

  // Upload the original image as a DataRecord.
  const createBody = JSON.stringify({
    type: "image",
    fileName: originalFilename,
    contentType: mimeType,
    fileBase64: fileBytes.toString("base64"),
  });
  const createRes = await signedFetch(creds, "/data/records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: createBody,
  });
  if (!createRes.ok) {
    const errBody = await createRes.text().catch(() => "");
    return NextResponse.json({ error: `Failed to create record: ${errBody}` }, { status: 502 });
  }
  const { record } = (await createRes.json()) as { record: PhotoRecord };

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

  // Write user metadata (title) and caption concurrently.
  await Promise.all([
    title
      ? signedFetch(creds, "/app-data/db/photos_user_metadata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ row: { record_id: record.id, title, updated_at: now } }),
        })
      : Promise.resolve(),
    caption
      ? signedFetch(creds, "/app-data/db/captions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ row: { image_id: record.id, caption, updated_at: now } }),
        })
      : Promise.resolve(),
  ]);

  // Fire-and-forget thumbnail generation.
  fetch(`${req.nextUrl.origin}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: record.id }),
  }).catch(() => {});

  const userMeta: PhotoUserMetadata | null = title ? { title } : null;
  return NextResponse.json({ image: photoRecordToAppImage(record, photoMeta, userMeta) }, { status: 201 });
}
