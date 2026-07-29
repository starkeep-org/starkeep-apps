import { type NextRequest, NextResponse } from "next/server";
import { remoteNotImplemented } from "@/vision/remote";
import { currentScanState, isScanning, startScan, stopScan } from "@/vision/scan-controller";

export const runtime = "nodejs";

/**
 * POST /api/vision/scan — start or stop a pass.
 *
 * Body: `{ "action": "start" | "stop" }`.
 *
 * Starting returns as soon as the worker is spawned; progress is polled from
 * `/api/vision/status`. Stopping is cooperative — the worker finishes the image
 * it is on, runs the end-of-pass clustering over what it did find, and exits.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;

  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  const action = body?.action;

  if (action === "stop") {
    return NextResponse.json({ scan: { ...stopScan(), running: isScanning() } });
  }
  if (action !== "start") {
    return NextResponse.json({ error: 'action must be "start" or "stop"' }, { status: 400 });
  }

  const result = await startScan();
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ scan: { ...currentScanState(), running: isScanning() } });
}
