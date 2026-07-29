import { type NextRequest, NextResponse } from "next/server";
import { LICENCE_SUMMARY } from "@/vision/licence";
import { startModelDownload } from "@/vision/model-download";
import { remoteNotImplemented } from "@/vision/remote";

export const runtime = "nodejs";

/**
 * POST /api/vision/models — start the face model download.
 *
 * Body: `{ "action": "download", "acceptLicence": true }`.
 *
 * `acceptLicence` is required and is the whole point of the route: the
 * antelopev2 weights are non-commercial-research-only, and the only reason it is
 * acceptable for a button to fetch them is that the button says so. A request
 * without it is refused rather than defaulted — a caller that never passed it is
 * a caller that never showed anyone the terms.
 *
 * Returns as soon as the transfer starts; progress is polled from
 * `/api/vision/status`, alongside everything else the panel already polls.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;

  const body = (await req.json().catch(() => null)) as {
    action?: unknown;
    acceptLicence?: unknown;
  } | null;

  if (body?.action !== "download") {
    return NextResponse.json({ error: 'action must be "download"' }, { status: 400 });
  }
  if (body.acceptLicence !== true) {
    return NextResponse.json(
      { error: `the antelopev2 weights are ${LICENCE_SUMMARY} — acceptLicence must be true` },
      { status: 400 },
    );
  }

  const result = startModelDownload();
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ download: result.download });
}
