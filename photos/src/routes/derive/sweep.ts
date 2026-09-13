import { sweepNotAvailableRemotely } from "@/derivation/remote";
import { currentSweepState, isSweeping, startSweep, stopSweep } from "@/derivation/sweep-controller";

/**
 * POST /api/derive/sweep — start or stop a pass.
 *
 * Body: `{ "action": "start" | "stop" }`.
 *
 * Starting returns as soon as the worker is spawned and resumes from wherever
 * the last pass stopped; progress is polled from `/api/derive/status`. Stopping
 * is cooperative — the worker finishes the record it is on, so a rendition is
 * never left uploaded but unregistered.
 */
export async function POST(req: Request): Promise<Response> {
  const remote = sweepNotAvailableRemotely();
  if (remote) return remote;

  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  const action = body?.action;

  if (action === "stop") {
    return Response.json({ sweep: { ...stopSweep(), running: isSweeping() } });
  }
  if (action !== "start") {
    return Response.json({ error: 'action must be "start" or "stop"' }, { status: 400 });
  }

  const result = await startSweep();
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json({ sweep: { ...currentSweepState(), running: isSweeping() } });
}
