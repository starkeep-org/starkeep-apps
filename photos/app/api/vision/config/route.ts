import { type NextRequest, NextResponse } from "next/server";
import { loadAppCredentials, signedFetch } from "@starkeep/app-client";
import { mergeVisionConfig, readVisionConfig, writeVisionConfig } from "@/vision/config";
import { publishFaceLabels, retractFaceLabels } from "@/vision/label-publish";
import { readConfirmedTags } from "@/vision/confirmed-tags";
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
  //
  // The one toggle covers names, face counts, and user-confirmed tags: all three are
  // the same disclosure decision — "let other apps see what I know about my photos" —
  // and splitting it would offer a choice nobody has a basis to make differently.
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
    // `init` is optional because the tag read is a plain GET, while the label
    // writes are POSTs — one fetcher serves both.
    const fetchAs = (path: string, init?: RequestInit) =>
      signedFetch(creds, path, init as Parameters<typeof signedFetch>[2]);
    try {
      // The confirmed tags come from `image_enriched` over the network, unlike
      // everything else the publisher folds. Read once, here, so the plan stays a
      // pure function of what it is given.
      const confirmed = await readConfirmedTags(fetchAs);
      labels = next.faces.publishLabels
        ? await publishFaceLabels(fetchAs, confirmed)
        : await retractFaceLabels(fetchAs, [...confirmed.keys()]);
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
