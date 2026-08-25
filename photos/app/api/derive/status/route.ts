import { NextResponse } from "next/server";
import { sweepNotAvailableRemotely } from "@/derivation/remote";
import { existsSync } from "node:fs";
import { currentSweepState, isSweeping, workerBundlePath } from "@/derivation/sweep-controller";
import { allAttempts } from "@/derivation/attempt-store";

export const runtime = "nodejs";
// Every field here is read off local disk, so a cached render would report a
// finished sweep as still running.
export const dynamic = "force-dynamic";

/**
 * GET /api/derive/status — how far derivation has got.
 *
 * This is what the UI reads for "still deriving" and what admin-web reads for
 * control. It matters more than a progress bar usually does, because the thing
 * it makes legible is otherwise invisible: **nothing derives when Photos is not
 * running**. That is equally true of a separate daemon, since the same
 * admin-web control starts both, so it is not an argument for one shape over
 * the other — it is an argument for saying so somewhere.
 */
export function GET(): Response {
  const remote = sweepNotAvailableRemotely();
  if (remote) return remote;

  const undecodable: string[] = [];
  for (const [recordId, attempt] of allAttempts()) {
    if (attempt.outcome === "undecodable-here") undecodable.push(recordId);
  }

  return NextResponse.json({
    // `running` comes from the controller rather than from the file: a process
    // killed mid-sweep leaves `running: true` on disk, and the handle is the
    // truth.
    sweep: { ...currentSweepState(), running: isSweeping() },
    worker: {
      built: existsSync(workerBundlePath()),
      path: workerBundlePath(),
      buildCommand: "pnpm derive:build-worker",
    },
    // Records this node has decided it cannot read. Node-local by design —
    // another machine may well manage them — so this is a statement about here.
    undecodableHere: { count: undecodable.length, recordIds: undecodable.slice(0, 100) },
  });
}
