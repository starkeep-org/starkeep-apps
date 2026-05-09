import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const DATA_SERVER = "http://127.0.0.1:9820";

/**
 * POST /api/generate
 * Generates a thumbnail DataRecord for an original image.
 * The data-server REST API uses `payload` (not `content`) for the record's JSON metadata,
 * and requires `fileBase64` to attach a file — not a pre-uploaded objectStorageKey.
 */
export async function POST(req: NextRequest) {
  const { targetId } = await req.json() as { targetId?: string; ownerId?: string };

  if (!targetId) {
    return NextResponse.json({ error: "targetId is required" }, { status: 400 });
  }

  // Fetch the source record
  const recordRes = await fetch(`${DATA_SERVER}/data/records/${targetId}`);
  if (!recordRes.ok) {
    return NextResponse.json({ error: "Record not found" }, { status: recordRes.status === 404 ? 404 : 502 });
  }
  const { record } = await recordRes.json() as { record: {
    id: string;
    object_storage_key: string | null;
    // data-server returns record.content as `payload` in all REST responses
    payload: { parentId?: string } | null;
    mime_type: string | null;
    original_filename: string | null;
    owner_id: string;
  } };

  if (!record.object_storage_key) {
    return NextResponse.json({ error: "Record has no attached file" }, { status: 422 });
  }

  // Guard: never generate a thumbnail for a record that is already a thumbnail
  const existingParentId = record.payload?.parentId;
  if (existingParentId && existingParentId !== "") {
    return NextResponse.json({ error: "Record is already a thumbnail" }, { status: 400 });
  }

  // Idempotency: if a thumbnail already exists for this original, return it
  const existingRes = await fetch(
    `${DATA_SERVER}/data/records?type=${encodeURIComponent("@starkeep/image")}&limit=1000`,
  );
  if (existingRes.ok) {
    const { records } = await existingRes.json() as { records: { id: string; payload?: { parentId?: string } }[] };
    const existing = records.find((r) => r.payload?.parentId === targetId);
    if (existing) {
      return NextResponse.json({ ok: true, thumbnailId: existing.id, skipped: true });
    }
  }

  // Fetch the source image file
  const fileUrlRes = await fetch(`${DATA_SERVER}/data/records/${targetId}/file-url`);
  if (!fileUrlRes.ok) {
    return NextResponse.json({ error: "Could not resolve source file URL" }, { status: 502 });
  }
  const { url: sourceUrl } = await fileUrlRes.json() as { url: string };

  const sourceRes = await fetch(sourceUrl);
  if (!sourceRes.ok) {
    return NextResponse.json({ error: "Could not fetch source image" }, { status: 502 });
  }
  const inputBuffer = Buffer.from(await sourceRes.arrayBuffer());

  // Resize with sharp
  const { default: sharp } = await import("sharp") as { default: typeof import("sharp") };
  const meta = await sharp(inputBuffer).metadata();
  const hasAlpha = meta.hasAlpha ?? false;
  const MAX_WIDTH = 400;

  const resized = await sharp(inputBuffer)
    .rotate()
    .resize(MAX_WIDTH, MAX_WIDTH, { fit: "inside", kernel: "cubic", withoutEnlargement: true })
    [hasAlpha ? "webp" : "jpeg"](hasAlpha ? { quality: 76 } : { quality: 85 })
    .toBuffer();

  const outputMeta = await sharp(resized).metadata();
  const mimeType = hasAlpha ? "image/webp" : "image/jpeg";
  const fileBase64 = resized.toString("base64");

  // Create the thumbnail DataRecord via the data-server REST API.
  // The server reads `payload` (stored as `content` in the DB) and `fileBase64` for the file.
  const createRes = await fetch(`${DATA_SERVER}/data/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "@starkeep/image",
      fileName: `thumb_${record.original_filename ?? "image"}`,
      contentType: mimeType,
      fileBase64,
      payload: {
        parentId: targetId,
        width: outputMeta.width ?? 0,
        height: outputMeta.height ?? 0,
        format: hasAlpha ? "webp" : "jpeg",
        title: "",
        caption: "",
        dateTakenOverride: null,
        googlePhotosId: null,
        sourceImageId: null,
        cropX: null,
        cropY: null,
        cropWidth: null,
        cropHeight: null,
        dateTakenRaw: null,
        cameraMake: null,
        cameraModel: null,
        fNumber: null,
        exposureTime: null,
        iso: null,
        lensModel: null,
        gpsLat: null,
        gpsLon: null,
        orientation: null,
      },
    }),
  });
  if (!createRes.ok) {
    const errBody = await createRes.text().catch(() => "");
    return NextResponse.json({ error: `Failed to create thumbnail record: ${errBody}` }, { status: 502 });
  }
  const { record: thumbnailRecord } = await createRes.json() as { record: { id: string } };

  // Trigger sync push (fire-and-forget)
  fetch(`${DATA_SERVER}/sync/now`, { method: "POST" }).catch(() => {});

  return NextResponse.json({ ok: true, thumbnailId: thumbnailRecord.id });
}
