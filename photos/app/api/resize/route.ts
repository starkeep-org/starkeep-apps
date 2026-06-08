import { type NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { loadAppCredentials, signedFetch } from "@starkeep/app-client";

export const runtime = "nodejs";

/**
 * POST /api/resize
 * Generates a thumbnail DataRecord for an original image. Bytes are uploaded
 * via presigned S3 PUT and the record is registered by content hash — same
 * shape as POST /api/photos. All HMAC-signed with the photos app's installed
 * credentials.
 */

function dataRecordObjectKey(typeId: string, contentHash: string): string {
  return `shared/${typeId}/${contentHash.slice(0, 2)}/${contentHash}`;
}

export async function POST(req: NextRequest) {
  const creds = loadAppCredentials("photos");
  if (!creds) {
    return NextResponse.json(
      { error: "photos has not been installed locally — run install from admin-web first" },
      { status: 503 },
    );
  }

  const { targetId } = await req.json() as { targetId?: string; ownerId?: string };

  if (!targetId) {
    return NextResponse.json({ error: "targetId is required" }, { status: 400 });
  }
  console.log(`[resize] start targetId=${targetId} appId=${creds.appId}`);

  // Fetch the source record
  const recordRes = await signedFetch(creds, `/data/records/${targetId}`);
  if (!recordRes.ok) {
    const errBody = await recordRes.text().catch(() => "");
    console.error(`[resize] GET /data/records/${targetId} → ${recordRes.status}: ${errBody}`);
    return NextResponse.json(
      { error: `Record fetch failed: ${recordRes.status} ${errBody}` },
      { status: recordRes.status === 404 ? 404 : 502 },
    );
  }
  const { record } = await recordRes.json() as { record: {
    id: string;
    object_storage_key: string | null;
    parent_id: string | null;
    mime_type: string | null;
    original_filename: string | null;
    owner_id: string;
  } };

  if (!record.object_storage_key) {
    return NextResponse.json({ error: "Record has no attached file" }, { status: 422 });
  }

  if (record.parent_id) {
    return NextResponse.json({ error: "Record is already a thumbnail" }, { status: 400 });
  }

  const existingRes = await signedFetch(creds, `/data/records?limit=1000`);
  if (existingRes.ok) {
    const { records } = await existingRes.json() as { records: { id: string; parent_id: string | null }[] };
    const existing = records.find((r) => r.parent_id === targetId);
    if (existing) {
      return NextResponse.json({ ok: true, thumbnailId: existing.id, skipped: true });
    }
  }

  // Fetch the source image file
  const fileUrlRes = await signedFetch(creds, `/data/records/${targetId}/file-url`);
  if (!fileUrlRes.ok) {
    const errBody = await fileUrlRes.text().catch(() => "");
    console.error(`[resize] file-url ${targetId} → ${fileUrlRes.status}: ${errBody}`);
    return NextResponse.json({ error: `file-url failed: ${fileUrlRes.status} ${errBody}` }, { status: 502 });
  }
  const { url: sourceUrl } = await fileUrlRes.json() as { url: string };

  // The file-url endpoint returns a self-signed token URL that doesn't need HMAC.
  const sourceRes = await fetch(sourceUrl);
  if (!sourceRes.ok) {
    const errBody = await sourceRes.text().catch(() => "");
    console.error(`[resize] source fetch ${sourceUrl} → ${sourceRes.status}: ${errBody.slice(0, 300)}`);
    return NextResponse.json({ error: `source fetch failed: ${sourceRes.status}` }, { status: 502 });
  }
  const inputBuffer = Buffer.from(await sourceRes.arrayBuffer());

  const { resizeForThumbnail } = await import("@/photos-lib/image-processing/resize");
  const MAX_WIDTH = 400;
  const resizeResult = await resizeForThumbnail(inputBuffer, MAX_WIDTH);
  const mimeType = resizeResult.contentType;
  const outputMeta = { width: resizeResult.width, height: resizeResult.height };
  const resizedBytes = new Uint8Array(resizeResult.data);

  // Upload via presigned S3 PUT, then register by content hash — same flow as
  // POST /api/photos. Avoids the API Gateway 7 MB cap on inline JSON bodies.
  const contentHash = createHash("sha256").update(resizedBytes).digest("hex");
  const objectStorageKey = dataRecordObjectKey("image", contentHash);

  const presignRes = await signedFetch(creds, `/files/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: objectStorageKey, contentType: mimeType }),
  });
  if (!presignRes.ok) {
    const errBody = await presignRes.text().catch(() => "");
    console.error(`[resize] presign → ${presignRes.status}: ${errBody}`);
    return NextResponse.json({ error: `Failed to presign upload: ${errBody}` }, { status: 502 });
  }
  const { url: uploadUrl } = (await presignRes.json()) as { url: string };

  const s3Res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: resizedBytes,
  });
  if (!s3Res.ok) {
    console.error(`[resize] S3 PUT → ${s3Res.status} ${s3Res.statusText}`);
    return NextResponse.json(
      { error: `S3 PUT failed: ${s3Res.status} ${s3Res.statusText}` },
      { status: 502 },
    );
  }

  const createRes = await signedFetch(creds, `/data/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // The thumbnail is re-encoded as JPEG above, so its true extension is "jpg".
      type: "jpg",
      fileName: `thumb_${record.original_filename ?? "image"}`,
      contentType: mimeType,
      contentHash,
      sizeBytes: resizedBytes.byteLength,
      parentId: targetId,
    }),
  });
  if (!createRes.ok) {
    const errBody = await createRes.text().catch(() => "");
    console.error(`[resize] create thumb → ${createRes.status}: ${errBody}`);
    return NextResponse.json({ error: `Failed to create thumbnail record: ${errBody}` }, { status: 502 });
  }
  const { record: thumbnailRecord } = await createRes.json() as { record: { id: string } };

  // Write image dimensions into the shared metadata table.
  const metaBody = JSON.stringify({
    typeId: "image",
    metadata: { width: outputMeta.width ?? 0, height: outputMeta.height ?? 0 },
  });
  const metaRes = await signedFetch(creds, `/data/records/${thumbnailRecord.id}/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: metaBody,
  });
  if (!metaRes.ok) {
    // Non-fatal: thumbnail exists; metadata write failure shouldn't abort the response.
    const errBody = await metaRes.text().catch(() => "");
    console.warn(`[resize] metadata write failed (non-fatal): ${metaRes.status} ${errBody}`);
  }

  // Trigger sync push (fire-and-forget). /sync/* requires app auth; sign
  // with empty body to match the server's HMAC scheme.
  signedFetch(creds, "/sync/now", { method: "POST" }).catch(() => {});

  return NextResponse.json({ ok: true, thumbnailId: thumbnailRecord.id });
}
