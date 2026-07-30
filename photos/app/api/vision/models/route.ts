import { type NextRequest, NextResponse } from "next/server";
import { startModelDownload } from "@/vision/model-download";
import { MODEL_GROUP_NAMES, MODEL_GROUPS, type ModelGroup } from "@/vision/models";
import { remoteNotImplemented } from "@/vision/remote";

export const runtime = "nodejs";

/**
 * POST /api/vision/models — start a model group's download.
 *
 * Body: `{ "action": "download", "group": "faces", "acceptLicence": true }`.
 * `group` defaults to `faces` so the shape that existed before groups did still
 * works.
 *
 * **`acceptLicence` is required only for a group that carries a restriction**, and
 * that conditionality is the point rather than a shortcut. The antelopev2 weights
 * are non-commercial-research-only, and the only reason it is acceptable for a
 * button to fetch them is that the button says so — a request without the flag is
 * a caller that never showed anyone the terms, so it is refused rather than
 * defaulted. Demanding the same flag for the Apache-2.0 scene and search weights
 * would be the mirror-image error: it would tell the user those carry a
 * restriction they do not have.
 *
 * Returns as soon as the transfer starts; progress is polled from
 * `/api/vision/status`, alongside everything else the panel already polls.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;

  const body = (await req.json().catch(() => null)) as {
    action?: unknown;
    group?: unknown;
    acceptLicence?: unknown;
  } | null;

  if (body?.action !== "download") {
    return NextResponse.json({ error: 'action must be "download"' }, { status: 400 });
  }

  const group = (body.group ?? "faces") as ModelGroup;
  if (!MODEL_GROUP_NAMES.includes(group)) {
    return NextResponse.json(
      { error: `group must be one of ${MODEL_GROUP_NAMES.join(", ")}` },
      { status: 400 },
    );
  }

  const info = MODEL_GROUPS[group];
  if (info.needsAck && body.acceptLicence !== true) {
    return NextResponse.json(
      { error: `the ${info.pack} weights are ${info.licence} — acceptLicence must be true` },
      { status: 400 },
    );
  }

  const result = startModelDownload(group);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ download: result.download });
}
