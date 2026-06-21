import { type NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { loadAppCredentials, signedFetch } from "@starkeep/app-client";
import { photoRecordToAppImage } from "../../../../src/lib/photoRecordToAppImage";
import type { PhotoRecord } from "../../../../src/lib/data-server-client";

export const runtime = "nodejs";

// Mirrors dataRecordObjectKey in @starkeep/protocol-primitives. Inlined to keep the route a
// thin Next runtime layer (matches the convention used in app/api/photos/route.ts).
function dataRecordObjectKey(typeId: string, contentHash: string): string {
  return `shared/${typeId}/${contentHash.slice(0, 2)}/${contentHash}`;
}

function notInstalled(): Response {
  return NextResponse.json(
    { error: "photos has not been installed locally — run install from admin-web first" },
    { status: 503 },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const creds = await loadAppCredentials("photos");
  if (!creds) return notInstalled();

  const body = (await req.json().catch(() => null)) as {
    sourceImageId?: string;
    cropRect?: { x: number; y: number; width: number; height: number };
  } | null;

  if (!body?.sourceImageId || !body.cropRect) {
    return NextResponse.json({ error: "sourceImageId and cropRect are required" }, { status: 400 });
  }
  const { sourceImageId, cropRect } = body;

  // Fetch the source record to get its filename and mime type.
  const recordRes = await signedFetch(creds, `/data/records/${sourceImageId}`);
  if (!recordRes.ok) {
    return NextResponse.json({ error: "Source record not found" }, { status: 404 });
  }
  const { record: sourceRecord } = (await recordRes.json()) as { record: PhotoRecord };

  // Get a download URL for the source file.
  const fileUrlRes = await signedFetch(creds, `/data/records/${sourceImageId}/file-url`);
  if (!fileUrlRes.ok) {
    return NextResponse.json({ error: "Failed to get source file URL" }, { status: 502 });
  }
  const { url: sourceUrl } = (await fileUrlRes.json()) as { url: string };

  const sourceRes = await fetch(sourceUrl);
  if (!sourceRes.ok) {
    return NextResponse.json({ error: "Failed to download source image" }, { status: 502 });
  }
  const sourceBytes = Buffer.from(await sourceRes.arrayBuffer());

  const { default: sharp } = await import("sharp") as { default: typeof import("sharp") };

  const cropped = await (sharp as typeof import("sharp"))(sourceBytes)
    .extract({ left: cropRect.x, top: cropRect.y, width: cropRect.width, height: cropRect.height })
    .jpeg({ quality: 90 })
    .toBuffer();

  const mimeType = "image/jpeg";
  const fileName = `crop_${sourceRecord.original_filename ?? "image"}`;

  // Upload via presigned S3 PUT, then register the record by content hash —
  // matches the canonical add-photo flow (addPhotoFromPath in
  // data-server-client.ts). The inline fileBase64 form 413s on real photos
  // once they go through API Gateway.
  const croppedBytes = new Uint8Array(cropped);
  const contentHash = createHash("sha256").update(croppedBytes).digest("hex");
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
    body: croppedBytes,
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
      // The crop is re-encoded as JPEG above, so its type is image/jpeg.
      type: "image/jpeg",
      fileName,
      contentType: mimeType,
      contentHash,
      sizeBytes: croppedBytes.byteLength,
      parentId: sourceImageId,
    }),
  });
  if (!createRes.ok) {
    const errBody = await createRes.text().catch(() => "");
    return NextResponse.json({ error: `Failed to create crop record: ${errBody}` }, { status: 502 });
  }
  const { record } = (await createRes.json()) as { record: PhotoRecord };

  // Write dimensions into shared image metadata.
  const metaRes = await signedFetch(creds, `/data/records/${record.id}/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      typeId: "image",
      metadata: { width: cropRect.width, height: cropRect.height },
    }),
  });
  const photoMeta = metaRes.ok
    ? { recordId: record.id, width: cropRect.width, height: cropRect.height }
    : null;

  return NextResponse.json({ image: photoRecordToAppImage(record, photoMeta) }, { status: 201 });
}
