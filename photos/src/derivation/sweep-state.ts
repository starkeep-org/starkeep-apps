/**
 * `sweep-state.json` — how far the sweep has read, and whether one is running.
 *
 * The file is the *record* of a pass, not the authority on liveness: a process
 * killed mid-sweep leaves `running: true` behind forever. The controller owns
 * liveness — it knows whether it holds a worker — and reconciles the file the
 * first time it is asked. Same split as the vision scan, and for the same
 * reason: the status endpoint polls, and a poll must not have to guess.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sweepStatePath } from "./paths";
import { emptySweepState, type SweepState } from "./types";

export function readSweepState(): SweepState {
  try {
    const parsed = JSON.parse(readFileSync(sweepStatePath(), "utf-8")) as Partial<SweepState>;
    return { ...emptySweepState(), ...parsed };
  } catch {
    return emptySweepState();
  }
}

export function writeSweepState(state: SweepState): void {
  const path = sweepStatePath();
  mkdirSync(dirname(path), { recursive: true });
  // Temp file and rename, so a process killed mid-write leaves the previous
  // cursor rather than a truncated one — which would read as "start over".
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}
