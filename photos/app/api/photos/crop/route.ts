import { type NextRequest, NextResponse } from "next/server";
import { loadLocalAppCredentials } from "../../../../src/lib/local-app-creds";
import { signedFetch } from "../../../../src/lib/data-server-fetch";
import { photoRecordToAppImage } from "../../../../src/lib/photoRecordToAppImage";
import type { PhotoRecord } from "../../../../src/lib/data-server-client";

export const runtime = "nodejs";

function notInstalled(): Response {
  return NextResponse.json(
    { error: "photos has not been installed locally — run install from admin-web first" },
    { status: 503 },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const creds = loadLocalAppCredentials();
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

  // Create a new DataRecord for the cropped image, linked to the source via parentId.
  const createBody = JSON.stringify({
    type: "image",
    fileName,
    contentType: mimeType,
    fileBase64: cropped.toString("base64"),
    parentId: sourceImageId,
  });
  const createRes = await signedFetch(creds, "/data/records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: createBody,
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
