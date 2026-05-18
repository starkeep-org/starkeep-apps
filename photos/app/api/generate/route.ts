import { type NextRequest, NextResponse } from "next/server";
import { loadLocalAppCredentials, signRequest, type AppCredentials } from "../../../src/lib/local-app-creds";

export const runtime = "nodejs";

/**
 * POST /api/generate
 * Generates a thumbnail DataRecord for an original image.
 * The data-server REST API uses `payload` (not `content`) for the record's JSON metadata,
 * and requires `fileBase64` to attach a file — not a pre-uploaded objectStorageKey.
 *
 * All calls to the data-server are HMAC-signed with the photos app's installed credentials.
 */

async function signedFetch(
  creds: AppCredentials,
  path: string,
  init?: RequestInit & { body?: string },
): Promise<Response> {
  const body = (init?.body as string | undefined) ?? "";
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
    ...signRequest(creds, init?.method && init.method !== "GET" ? body : ""),
  };
  return fetch(`${creds.dataServerUrl}${path}`, { ...init, headers });
}

export async function POST(req: NextRequest) {
  const creds = loadLocalAppCredentials();
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
  console.log(`[generate] start targetId=${targetId} appId=${creds.appId}`);

  // Fetch the source record
  const recordRes = await signedFetch(creds, `/data/records/${targetId}`);
  if (!recordRes.ok) {
    const errBody = await recordRes.text().catch(() => "");
    console.error(`[generate] GET /data/records/${targetId} → ${recordRes.status}: ${errBody}`);
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

  const existingRes = await signedFetch(creds, `/data/records?type=image&limit=1000`);
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
    console.error(`[generate] file-url ${targetId} → ${fileUrlRes.status}: ${errBody}`);
    return NextResponse.json({ error: `file-url failed: ${fileUrlRes.status} ${errBody}` }, { status: 502 });
  }
  const { url: sourceUrl } = await fileUrlRes.json() as { url: string };

  // The file-url endpoint returns a self-signed token URL that doesn't need HMAC.
  const sourceRes = await fetch(sourceUrl);
  if (!sourceRes.ok) {
    const errBody = await sourceRes.text().catch(() => "");
    console.error(`[generate] source fetch ${sourceUrl} → ${sourceRes.status}: ${errBody.slice(0, 300)}`);
    return NextResponse.json({ error: `source fetch failed: ${sourceRes.status}` }, { status: 502 });
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

  // Create the thumbnail DataRecord.
  const createBody = JSON.stringify({
    type: "image",
    fileName: `thumb_${record.original_filename ?? "image"}`,
    contentType: mimeType,
    fileBase64,
    parentId: targetId,
  });
  const createRes = await signedFetch(creds, `/data/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: createBody,
  });
  if (!createRes.ok) {
    const errBody = await createRes.text().catch(() => "");
    console.error(`[generate] create thumb → ${createRes.status}: ${errBody}`);
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
    console.warn(`[generate] metadata write failed (non-fatal): ${metaRes.status} ${errBody}`);
  }

  // Trigger sync push (fire-and-forget) — sync endpoints don't require app auth.
  fetch(`${creds.dataServerUrl}/sync/now`, { method: "POST" }).catch(() => {});

  return NextResponse.json({ ok: true, thumbnailId: thumbnailRecord.id });
}
