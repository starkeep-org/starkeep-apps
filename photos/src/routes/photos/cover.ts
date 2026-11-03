import { createHash } from "node:crypto";
import { authorizePhotosRoute, withRefreshedSession } from "@/lib/photos-route-server";

const COVER_SUBKEY = "cover";
const MAX_COVER_BYTES = 20_000_000;

/**
 * Photos-owned "cover image" API — the proving client for the app-specific
 * synced *file* plane (mirrors how the captions route proves the db plane).
 *
 * A cover image is a single app-private file (subKey "cover") that rides the
 * platform's direct-to-S3 presign flow: presign → upload straight to storage →
 * register the index row. The browser only ever sees `{ url }` (a time-limited
 * download link) or sends raw image bytes; the `apps/photos/syncable/cover`
 * storage key and the two-step upload are platform details mediated here.
 */

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Current cover download URL, or `{ url: null }` when none is set. */
export async function GET(req: Request): Promise<Response> {
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;
  const upstream = await authorized.fetch(`/app-data/files/${COVER_SUBKEY}`);
  if (upstream.status === 404) {
    return withRefreshedSession(Response.json({ url: null }), authorized.refreshedCookie);
  }
  if (!upstream.ok) {
    return Response.json({ url: null }, { status: upstream.status });
  }
  const { url } = (await upstream.json()) as { url: string };
  return withRefreshedSession(Response.json({ url }), authorized.refreshedCookie);
}

/** Set the cover image. Body: raw image bytes; Content-Type is the mime type. */
export async function PUT(req: Request): Promise<Response> {
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;

  const mimeType = (req.headers.get("content-type") ?? "application/octet-stream")
    .split(";")[0]!
    .trim();
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length === 0) {
    return Response.json({ error: "Request body must not be empty" }, { status: 400 });
  }
  if (bytes.length > MAX_COVER_BYTES) {
    return Response.json({ error: "Cover image too large (20 MB limit)" }, { status: 413 });
  }

  // 1. Presign — the platform builds the storage key from appId + subKey and
  //    pins the hash, so the store keeps a whole-file SHA-256 for the cover.
  const contentHash = sha256Hex(bytes);
  const presignRes = await authorized.fetch(`/app-data/files/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subKey: COVER_SUBKEY, contentType: mimeType, contentHash }),
  });
  if (!presignRes.ok) {
    const detail = await presignRes.text().catch(() => "");
    return Response.json({ error: detail || "Failed to presign cover upload" }, { status: 502 });
  }
  const { url: uploadUrl, checksumSha256 } = (await presignRes.json()) as {
    url: string;
    checksumSha256?: string;
  };

  // 2. Upload bytes straight to storage (no app HMAC — the URL is the grant).
  //    The checksum header is part of the cloud's signature when it pinned one.
  const uploaded = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      ...(checksumSha256 ? { "x-amz-checksum-sha256": checksumSha256 } : {}),
    },
    body: bytes as unknown as BodyInit,
  });
  if (!uploaded.ok) {
    return Response.json(
      { error: `Cover upload failed: ${uploaded.status}` },
      { status: 502 },
    );
  }

  // 3. Register the index row so the file is visible to existence checks and
  //    cross-channel sync (the platform never held the bytes).
  const registered = await authorized.fetch(`/app-data/files/${COVER_SUBKEY}/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contentHash,
      mimeType,
      sizeBytes: bytes.length,
    }),
  });
  if (!registered.ok) {
    const detail = await registered.text().catch(() => "");
    return Response.json({ error: detail || "Failed to register cover" }, { status: 502 });
  }

  return withRefreshedSession(Response.json({ ok: true }), authorized.refreshedCookie);
}

/** Remove the cover image. */
export async function DELETE(req: Request): Promise<Response> {
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;
  await authorized.fetch(`/app-data/files/${COVER_SUBKEY}`, { method: "DELETE" });
  return withRefreshedSession(Response.json({ ok: true }), authorized.refreshedCookie);
}
