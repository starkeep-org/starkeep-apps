/**
 * `scan-state.json` — what the last pass did, and whether one is running.
 *
 * The file is the *record* of a pass, not the authority on liveness: a process
 * killed mid-scan leaves `running: true` behind forever. The scan controller
 * owns liveness (it knows whether it has a worker), and reconciles the file on
 * boot — see `scan-controller.ts`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { scanStatePath } from "./paths";
import { emptyScanState, type ScanState } from "./types";

export function readScanState(): ScanState {
  try {
    const parsed = JSON.parse(readFileSync(scanStatePath(), "utf-8")) as Partial<ScanState>;
    return { ...emptyScanState(), ...parsed, processed: parsed.processed ?? {} };
  } catch {
    return emptyScanState();
  }
}

export function writeScanState(state: ScanState): void {
  const path = scanStatePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}
