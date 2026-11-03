import { authorizePhotosRoute, withRefreshedSession } from "@/lib/photos-route-server";

const STYLE_GRAPHIC_KEY = "style-graphic";
const MAX_BYTES = 5_000_000;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * Photos-owned style-graphic API. The platform's `/app-data/files/style-graphic`
 * endpoint accepts arbitrary bytes; we mediate it here so we can enforce a mime
 * whitelist and a size cap, and so the browser doesn't need to know the
 * underlying object-storage key.
 *
 * Upload transport is a raw-bytes PUT (Content-Type carries the mime; the body
 * is the file). Same-origin so no CORS / preflight; no base64 inflation.
 */

export async function GET(req: Request): Promise<Response> {
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;
  const upstream = await authorized.fetch(`/app-data/files/${STYLE_GRAPHIC_KEY}`);
  if (upstream.status === 404) {
    return withRefreshedSession(Response.json({ url: null }), authorized.refreshedCookie);
  }
  if (!upstream.ok) {
    return Response.json({ url: null, error: `Upstream ${upstream.status}` }, { status: 502 });
  }
  const body = (await upstream.json()) as { url?: string };
  return withRefreshedSession(
    Response.json({ url: body.url ?? null }),
    authorized.refreshedCookie,
  );
}

export async function PUT(req: Request): Promise<Response> {
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;
  const mimeType = (req.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!ALLOWED_MIME.has(mimeType)) {
    return Response.json(
      { error: `Content-Type must be one of: ${[...ALLOWED_MIME].join(", ")}` },
      { status: 400 },
    );
  }
  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length === 0) {
    return Response.json({ error: "Empty file" }, { status: 400 });
  }
  if (bytes.length > MAX_BYTES) {
    return Response.json(
      { error: `File too large (max ${MAX_BYTES} bytes)` },
      { status: 413 },
    );
  }
  const upstream = await authorized.fetch(`/app-data/files/${STYLE_GRAPHIC_KEY}`, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: bytes,
  });
  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => "");
    return Response.json({ error: errBody || "Upload failed" }, { status: 502 });
  }
  return withRefreshedSession(Response.json({ ok: true }), authorized.refreshedCookie);
}

export async function DELETE(req: Request): Promise<Response> {
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;
  await authorized.fetch(`/app-data/files/${STYLE_GRAPHIC_KEY}`, { method: "DELETE" });
  return withRefreshedSession(Response.json({ ok: true }), authorized.refreshedCookie);
}
