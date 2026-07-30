import { NextResponse } from "next/server";
import { className } from "@/vision/coco-classes";
import { remoteNotImplemented } from "@/vision/remote";
import { readObjectSidecar } from "@/vision/sidecars";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/vision/objects/[id] — the detections for one image, for the viewer's
 * labelled-box overlay.
 *
 * Class **names** are resolved here rather than in the browser. The sidecar stores
 * indices, because the index is what the model emitted and a name would bake a
 * spelling into every file on disk — but the index is meaningless to a client, and
 * shipping the whole 80-entry table to the browser to decode three boxes would be
 * the wrong trade.
 *
 * `processed: false` distinguishes "not scanned yet" from "scanned, found nothing"
 * — the overlay shows nothing either way, but the UI can say which.
 */
export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;

  const { id } = await ctx.params;
  const sidecar = readObjectSidecar(id);
  if (!sidecar) {
    return NextResponse.json({ processed: false, objects: [] });
  }

  return NextResponse.json({
    processed: true,
    processedAt: sidecar.processedAt,
    // Display-orientation dimensions the boxes are relative to. The client scales
    // by these rather than by the record's stored width/height, which are
    // pre-rotation and therefore swapped on EXIF-rotated photos.
    width: sidecar.w,
    height: sidecar.h,
    objects: sidecar.objects.map((object, index) => ({
      index,
      bbox: object.bbox,
      score: object.score,
      // An index this build cannot name means the sidecar came from a different
      // class table — treated as unnamed rather than crashing the overlay, and the
      // model-id staleness check will reprocess it.
      name: className(object.cls) ?? "",
    })),
  });
}
