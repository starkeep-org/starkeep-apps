import { type NextRequest, NextResponse } from "next/server";
import { loadAppCredentials, signedFetch } from "@starkeep/app-client";
import { remoteNotImplemented } from "@/vision/remote";
import { isCurrent, readFaceSidecar } from "@/vision/sidecars";

export const runtime = "nodejs";

/** Rendered size of a face tile in the People view. */
const CROP_SIZE = 160;
/** Context around the box — a tight ArcFace box reads as a disembodied nose. */
const PADDING_RATIO = 0.35;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/vision/face-crop/[id]?face=N — a JPEG of one detected face.
 *
 * Deliberately **not** `/api/photos/crop`: that route creates a DataRecord, and
 * the People view needs one tile per face per cluster. Reusing it would put
 * hundreds of crop records in the user's library — visible in the grid, synced
 * to every device — to render a thumbnail. This returns transient bytes and
 * writes nothing.
 *
 * `.rotate()` first, because the sidecar's boxes are in display orientation.
 */
export async function GET(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;

  const { id } = await ctx.params;
  const faceIndex = Number(req.nextUrl.searchParams.get("face") ?? "0");
  if (!Number.isInteger(faceIndex) || faceIndex < 0) {
    return NextResponse.json({ error: "face must be a non-negative integer" }, { status: 400 });
  }

  const sidecar = readFaceSidecar(id);
  if (!sidecar || !isCurrent(sidecar)) {
    return NextResponse.json({ error: "no current detections for that record" }, { status: 404 });
  }
  const face = sidecar.faces[faceIndex];
  if (!face) return NextResponse.json({ error: "no such face" }, { status: 404 });

  const creds = await loadAppCredentials("photos");
  if (!creds) {
    return NextResponse.json(
      { error: "photos has not been installed locally — run install from admin-web first" },
      { status: 503 },
    );
  }

  const urlRes = await signedFetch(creds, `/data/records/${id}/file-url`);
  if (!urlRes.ok) {
    return NextResponse.json({ error: "source image is unavailable" }, { status: 502 });
  }
  const { url } = (await urlRes.json()) as { url: string };
  const sourceRes = await fetch(url);
  if (!sourceRes.ok) {
    return NextResponse.json({ error: "source image download failed" }, { status: 502 });
  }
  const bytes = Buffer.from(await sourceRes.arrayBuffer());

  const { default: sharp } = (await import("sharp")) as { default: typeof import("sharp") };
  const rotated = sharp(bytes).rotate();
  const meta = await rotated.metadata();
  const imageWidth = meta.width ?? sidecar.w;
  const imageHeight = meta.height ?? sidecar.h;

  const [x, y, w, h] = face.bbox;
  const pad = Math.max(w, h) * PADDING_RATIO;
  // Clamped to the frame: a face at the edge yields a smaller crop rather than
  // a sharp `extract` error on an out-of-bounds rectangle.
  const left = Math.max(0, Math.round(x - pad));
  const top = Math.max(0, Math.round(y - pad));
  const width = Math.max(1, Math.min(imageWidth - left, Math.round(w + pad * 2)));
  const height = Math.max(1, Math.min(imageHeight - top, Math.round(h + pad * 2)));

  const out = await rotated
    .extract({ left, top, width, height })
    .resize(CROP_SIZE, CROP_SIZE, { fit: "cover" })
    .jpeg({ quality: 80 })
    .toBuffer();

  return new Response(new Uint8Array(out), {
    headers: {
      "Content-Type": "image/jpeg",
      // Sidecars are immutable once written for a given model, and the record
      // id plus face index pins the bytes — so this is safe to cache, and the
      // People view asks for a lot of these at once.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
