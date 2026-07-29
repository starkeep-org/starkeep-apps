import { NextResponse } from "next/server";
import { remoteNotImplemented } from "@/vision/remote";
import { readFaceSidecar, isCurrent } from "@/vision/sidecars";
import { readPeople } from "@/vision/people";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/vision/faces/[id] — the detections for one image, for the viewer's
 * bounding-box overlay.
 *
 * Embeddings are **not** returned. The overlay needs geometry and a name; the
 * 512-d vectors are biometric data with no business in a browser, and they are
 * the bulk of the sidecar besides.
 *
 * `processed: false` distinguishes "not scanned yet" from "scanned, no faces" —
 * the overlay shows nothing either way, but the UI can say which.
 */
export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;

  const { id } = await ctx.params;
  const sidecar = readFaceSidecar(id);
  if (!sidecar || !isCurrent(sidecar)) {
    return NextResponse.json({ processed: false, faces: [] });
  }

  const namesById = new Map(readPeople().map((p) => [p.id, p.name]));
  return NextResponse.json({
    processed: true,
    processedAt: sidecar.processedAt,
    // Display-orientation dimensions the boxes are relative to. The client
    // scales by these rather than by the record's stored width/height, which
    // are pre-rotation and therefore swapped on EXIF-rotated photos.
    width: sidecar.w,
    height: sidecar.h,
    faces: sidecar.faces.map((face, index) => ({
      index,
      bbox: face.bbox,
      score: face.score,
      personId: face.personId,
      name: face.personId ? (namesById.get(face.personId) ?? "") : "",
    })),
  });
}
