import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, renameSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentSweepState,
  isSweeping,
  resumePoint,
  startSweep,
  waitForSweepIdle,
  workerBundlePath,
} from "@/derivation/sweep-controller";
import { readSweepState, writeSweepState } from "@/derivation/sweep-state";
import { emptySweepState } from "@/derivation/types";

/**
 * The sweep lifecycle owner.
 *
 * Two things live here that the state file cannot hold. Whether a sweep is
 * *actually* running, as opposed to whether a file says so — a process killed
 * mid-pass leaves `running: true` behind forever, and the status endpoint polls
 * this rather than the file for exactly that reason. And the cursor's survival
 * across that death, which is the difference between resuming a 60,000-record
 * pass and restarting it.
 *
 * No worker is spawned: every assertion below is about what happens before
 * that, which is the point — a test that had to run a real sweep would not get
 * run.
 */

let root: string;
let previousDir: string | undefined;

function resetController(): void {
  const key = Symbol.for("starkeep.photos.derivation.sweepController");
  delete (globalThis as unknown as Record<symbol, unknown>)[key];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "starkeep-derive-controller-"));
  previousDir = process.env.STARKEEP_DIR;
  process.env.STARKEEP_DIR = root;
  resetController();
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.STARKEEP_DIR;
  else process.env.STARKEEP_DIR = previousDir;
  rmSync(root, { recursive: true, force: true });
  resetController();
});

describe("a sweep that died with its process", () => {
  it("is reported as not running, and its cursor is kept", () => {
    // What a `kill -9` mid-pass leaves on disk.
    writeSweepState({
      ...emptySweepState(),
      running: true,
      stage: "full",
      cursor: "cursor-halfway",
      examined: 4000,
    });

    const state = currentSweepState();
    expect(state.running).toBe(false);
    expect(isSweeping()).toBe(false);
    // The cursor is the whole reason the file exists. Clearing it on
    // reconciliation would turn every crash into a restart from the top.
    expect(state.cursor).toBe("cursor-halfway");
    expect(state.stage).toBe("full");
    expect(state.error).toMatch(/interrupted/);
  });

  it("persists the reconciliation, so a second reader sees the same thing", () => {
    writeSweepState({ ...emptySweepState(), running: true, cursor: "c1" });
    currentSweepState();
    expect(readSweepState().running).toBe(false);
    expect(readSweepState().cursor).toBe("c1");
  });
});

describe("starting without a built worker", () => {
  it("refuses with the command that fixes it, rather than a stack trace", async () => {
    // The bundle is a build artefact; a checkout that has not run the build
    // script has no worker to start, and that is an instruction, not an error.
    const bundle = workerBundlePath();
    const stashed = `${bundle}.stashed-by-test`;
    const wasBuilt = existsSync(bundle);
    if (wasBuilt) renameSync(bundle, stashed);
    try {
      const result = await startSweep();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(500);
      expect(result.error).toContain("derive:build-worker");
    } finally {
      if (wasBuilt) renameSync(stashed, bundle);
    }
  });
});

describe("a library nobody has swept", () => {
  it("starts at the cheap stage with no cursor", () => {
    const state = currentSweepState();
    expect(state.stage).toBe("cheap");
    expect(state.cursor).toBeNull();
    expect(state.running).toBe(false);
  });

  it("reports idle immediately when there is no worker to wait for", async () => {
    await expect(waitForSweepIdle()).resolves.toMatchObject({ running: false });
  });
});

describe("starting another pass", () => {
  it("starts completed passes over at cheap so newly ingested stills are discovered", () => {
    expect(
      resumePoint({
        ...emptySweepState(),
        stage: "video",
        cursor: null,
        completed: true,
        finishedAt: "2026-08-25T00:00:00.000Z",
      }),
    ).toEqual({ stage: "cheap", cursor: null });
  });

  it("migrates a successful final-stage state written before completed was recorded", () => {
    expect(
      resumePoint({
        ...emptySweepState(),
        stage: "video",
        cursor: null,
        finishedAt: "2026-08-25T00:00:00.000Z",
        error: null,
      }),
    ).toEqual({ stage: "cheap", cursor: null });
  });

  it("keeps an interrupted pass's exact stage and cursor", () => {
    expect(
      resumePoint({
        ...emptySweepState(),
        stage: "full",
        cursor: "page-20",
        completed: false,
      }),
    ).toEqual({ stage: "full", cursor: "page-20" });
  });
});
