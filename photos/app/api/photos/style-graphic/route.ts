import { type NextRequest, NextResponse } from "next/server";
import { loadLocalAppCredentials } from "../../../../src/lib/local-app-creds";
import { signedFetch } from "../../../../src/lib/data-server-fetch";

export const runtime = "nodejs";

const STYLE_GRAPHIC_KEY = "style-graphic";
const MAX_BYTES = 5_000_000;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * Photos-owned style-graphic API. The platform's `/app-data/files/style-graphic`
 * endpoint accepts arbitrary bytes; we mediate it here so we can enforce a mime
 * whitelist and a size cap, and so the browser doesn't need to know the
 * underlying object-storage key.
 *
 * Upload transport is `{ fileBase64, mimeType }` JSON to keep things text-only
 * across the wire (matches the existing photo upload path). The route decodes
 * to a Buffer and sends raw bytes to the platform, which stores them under the
 * app's syncable file prefix.
 */

function notInstalled(): Response {
  return NextResponse.json(
    { error: "photos has not been installed locally — run install from admin-web first" },
    { status: 503 },
  );
}

export async function GET(): Promise<Response> {
  const creds = loadLocalAppCredentials();
  if (!creds) return notInstalled();
  const upstream = await signedFetch(creds, `/app-data/files/${STYLE_GRAPHIC_KEY}`);
  if (upstream.status === 404) {
    return NextResponse.json({ url: null });
  }
  if (!upstream.ok) {
    return NextResponse.json({ url: null, error: `Upstream ${upstream.status}` }, { status: 502 });
  }
  const body = (await upstream.json()) as { url?: string };
  return NextResponse.json({ url: body.url ?? null });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const creds = loadLocalAppCredentials();
  if (!creds) return notInstalled();
  const body = (await req.json().catch(() => null)) as
    | { fileBase64?: unknown; mimeType?: unknown }
    | null;
  if (!body || typeof body.fileBase64 !== "string" || typeof body.mimeType !== "string") {
    return NextResponse.json(
      { error: "{fileBase64, mimeType} required" },
      { status: 400 },
    );
  }
  if (!ALLOWED_MIME.has(body.mimeType)) {
    return NextResponse.json(
      { error: `mimeType must be one of: ${[...ALLOWED_MIME].join(", ")}` },
      { status: 400 },
    );
  }
  const bytes = Buffer.from(body.fileBase64, "base64");
  if (bytes.length === 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }
  if (bytes.length > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_BYTES} bytes)` },
      { status: 413 },
    );
  }
  const upstream = await signedFetch(creds, `/app-data/files/${STYLE_GRAPHIC_KEY}`, {
    method: "PUT",
    headers: { "Content-Type": body.mimeType },
    body: bytes,
  });
  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => "");
    return NextResponse.json({ error: errBody || "Upload failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(): Promise<Response> {
  const creds = loadLocalAppCredentials();
  if (!creds) return notInstalled();
  await signedFetch(creds, `/app-data/files/${STYLE_GRAPHIC_KEY}`, { method: "DELETE" });
  return NextResponse.json({ ok: true });
}
