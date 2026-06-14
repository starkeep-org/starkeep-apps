import { type NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { loadAppCredentials, signedFetch } from "@starkeep/app-client";

export const runtime = "nodejs";

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

function notInstalled(): Response {
  return NextResponse.json(
    { error: "photos has not been installed locally — run install from admin-web first" },
    { status: 503 },
  );
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Current cover download URL, or `{ url: null }` when none is set. */
export async function GET(): Promise<Response> {
  const creds = await loadAppCredentials("photos");
  if (!creds) return notInstalled();
  const upstream = await signedFetch(creds, `/app-data/files/${COVER_SUBKEY}`);
  if (upstream.status === 404) return NextResponse.json({ url: null });
  if (!upstream.ok) {
    return NextResponse.json({ url: null }, { status: upstream.status });
  }
  const { url } = (await upstream.json()) as { url: string };
  return NextResponse.json({ url });
}

/** Set the cover image. Body: raw image bytes; Content-Type is the mime type. */
export async function PUT(req: NextRequest): Promise<Response> {
  const creds = await loadAppCredentials("photos");
  if (!creds) return notInstalled();

  const mimeType = (req.headers.get("content-type") ?? "application/octet-stream")
    .split(";")[0]!
    .trim();
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length === 0) {
    return NextResponse.json({ error: "Request body must not be empty" }, { status: 400 });
  }
  if (bytes.length > MAX_COVER_BYTES) {
    return NextResponse.json({ error: "Cover image too large (20 MB limit)" }, { status: 413 });
  }

  // 1. Presign — the platform builds the storage key from appId + subKey.
  const presignRes = await signedFetch(creds, `/app-data/files/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subKey: COVER_SUBKEY, contentType: mimeType }),
  });
  if (!presignRes.ok) {
    const detail = await presignRes.text().catch(() => "");
    return NextResponse.json({ error: detail || "Failed to presign cover upload" }, { status: 502 });
  }
  const { url: uploadUrl } = (await presignRes.json()) as { url: string };

  // 2. Upload bytes straight to storage (no app HMAC — the URL is the grant).
  const uploaded = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: bytes as unknown as BodyInit,
  });
  if (!uploaded.ok) {
    return NextResponse.json(
      { error: `Cover upload failed: ${uploaded.status}` },
      { status: 502 },
    );
  }

  // 3. Register the index row so the file is visible to existence checks and
  //    cross-channel sync (the platform never held the bytes).
  const registered = await signedFetch(creds, `/app-data/files/${COVER_SUBKEY}/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contentHash: sha256Hex(bytes),
      mimeType,
      sizeBytes: bytes.length,
    }),
  });
  if (!registered.ok) {
    const detail = await registered.text().catch(() => "");
    return NextResponse.json({ error: detail || "Failed to register cover" }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}

/** Remove the cover image. */
export async function DELETE(): Promise<Response> {
  const creds = await loadAppCredentials("photos");
  if (!creds) return notInstalled();
  await signedFetch(creds, `/app-data/files/${COVER_SUBKEY}`, { method: "DELETE" });
  return NextResponse.json({ ok: true });
}
