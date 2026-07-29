import { type NextRequest, NextResponse } from "next/server";
import { loadAppCredentials, signedFetch } from "@starkeep/app-client";
import { mergeVisionConfig, readVisionConfig, writeVisionConfig } from "@/vision/config";
import { publishFaceLabels, retractFaceLabels } from "@/vision/label-publish";
import { remoteNotImplemented } from "@/vision/remote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET|PUT /api/vision/config — the on-device vision toggles. */
export async function GET(): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;
  return NextResponse.json({ config: readVisionConfig() });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;

  const patch = await req.json().catch(() => null);
  const previous = readVisionConfig();
  const next = mergeVisionConfig(previous, patch);
  writeVisionConfig(next);

  // Flipping `publishLabels` has to actually take effect, in both directions.
  // A toggle that only gates *future* writes would leave the names it already
  // published on the shared plane after being turned off, which makes it a lie
  // about the disclosure it exists to control.
  let labels: unknown = null;
  if (next.faces.publishLabels !== previous.faces.publishLabels) {
    const creds = await loadAppCredentials("photos");
    if (!creds) {
      return NextResponse.json(
        {
          config: next,
          warning:
            "photos is not installed locally, so the label change could not be applied — " +
            "the setting was saved",
        },
        { status: 200 },
      );
    }
    const fetchAs = (path: string, init: RequestInit) =>
      signedFetch(creds, path, init as Parameters<typeof signedFetch>[2]);
    try {
      labels = next.faces.publishLabels
        ? await publishFaceLabels(fetchAs)
        : await retractFaceLabels(fetchAs);
    } catch (err) {
      return NextResponse.json(
        {
          config: next,
          warning: err instanceof Error ? err.message : String(err),
        },
        { status: 200 },
      );
    }
  }

  return NextResponse.json({ config: next, labels });
}
