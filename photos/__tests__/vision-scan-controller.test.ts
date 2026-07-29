import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeVisionConfig } from "@/vision/config";
import { FACE_MODELS } from "@/vision/models";
import { modelsDir } from "@/vision/paths";
import { readScanState, writeScanState } from "@/vision/scan-state";
import {
  currentScanState,
  isScanning,
  startScan,
  stopScan,
  workerBundlePath,
} from "@/vision/scan-controller";
import { emptyScanState } from "@/vision/types";

/**
 * The scan lifecycle owner.
 *
 * Every refusal here has a distinct status the UI renders differently, and none
 * of them had a test. The controller also owns the one piece of state
 * `scan-state.json` cannot: whether a scan is *actually* running, as opposed to
 * whether a file says so.
 *
 * No worker is spawned. The four refusals below all happen before that, which is
 * the point — a test that had to load 261 MB of weights to check an error
 * message would not get run.
 */

let root: string;
let previousDir: string | undefined;

/** Files of the right size, so `faceModelStatus` reports them installed. */
function installFakeModels(): void {
  mkdirSync(modelsDir(), { recursive: true });
  for (const model of FACE_MODELS) {
    writeFileSync(join(modelsDir(), model.fileName), Buffer.alloc(model.sizeBytes));
  }
}

/** Resets the controller's cross-module singleton between tests. */
function resetController(): void {
  const key = Symbol.for("starkeep.photos.vision.scanController");
  delete (globalThis as unknown as Record<symbol, unknown>)[key];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "starkeep-controller-"));
  previousDir = process.env.STARKEEP_DIR;
  process.env.STARKEEP_DIR = root;
  resetController();
});

afterEach(() => {
  resetController();
  if (previousDir === undefined) delete process.env.STARKEEP_DIR;
  else process.env.STARKEEP_DIR = previousDir;
  rmSync(root, { recursive: true, force: true });
});

describe("startScan refusals", () => {
  it("refuses while face detection is off", async () => {
    const result = await startScan();
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok === false && result.error).toMatch(/face detection is off/);
  });

  it("refuses without the models, naming which are missing", async () => {
    writeVisionConfig({ faces: { enabled: true, threshold: 0.45, publishLabels: false } });
    const result = await startScan();
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok === false && result.error).toContain("scrfd_10g_bnkps.onnx");
    expect(result.ok === false && result.error).toContain("glintr100.onnx");
  });

  it("treats a wrong-size model file as missing", async () => {
    // A truncated download must not present as installed — the failure would
    // otherwise surface as an opaque ONNX load error mid-scan.
    writeVisionConfig({ faces: { enabled: true, threshold: 0.45, publishLabels: false } });
    mkdirSync(modelsDir(), { recursive: true });
    for (const model of FACE_MODELS) {
      writeFileSync(join(modelsDir(), model.fileName), Buffer.alloc(1024));
    }
    const result = await startScan();
    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses with a 500 when the worker has not been built", async () => {
    // A different class of problem from the two above: not something the user
    // forgot, something the build did — hence 500, not 409.
    //
    // The bundle path is fixed and has no override (deliberately — see
    // `workerBundlePath`), so the only way to test its absence is to make it
    // absent. Moved aside and restored rather than deleted: on a dev machine
    // this file is a real build output.
    writeVisionConfig({ faces: { enabled: true, threshold: 0.45, publishLabels: false } });
    installFakeModels();

    const bundle = workerBundlePath();
    const stashed = `${bundle}.test-stash`;
    const present = existsSync(bundle);
    if (present) renameSync(bundle, stashed);
    try {
      const result = await startScan();
      expect(result).toMatchObject({ ok: false, status: 500 });
      expect(result.ok === false && result.error).toMatch(/vision:build-worker/);
    } finally {
      if (present) renameSync(stashed, bundle);
    }
  });

  it("spawns nothing on any refusal", async () => {
    // Models absent, so this refuses before it would reach the worker at all.
    writeVisionConfig({ faces: { enabled: true, threshold: 0.45, publishLabels: false } });
    await startScan();
    expect(isScanning()).toBe(false);
  });
});

describe("liveness", () => {
  it("reports not scanning before anything has run", () => {
    expect(isScanning()).toBe(false);
    expect(currentScanState().running).toBe(false);
  });

  it("reconciles a running flag left behind by a killed process", () => {
    // `scan-state.json` is a record, not an authority. A process killed
    // mid-pass leaves `running: true` forever; the controller knows it holds no
    // worker, and without this the Scan card reports a running scan and every
    // start is rejected as a duplicate.
    writeScanState({
      ...emptyScanState(),
      running: true,
      eligible: 100,
      processed: { faces: 42 },
      startedAt: "2026-07-28T00:00:00.000Z",
    });

    const state = currentScanState();
    expect(state.running).toBe(false);
    expect(state.error).toMatch(/interrupted/);
    // The progress it did make is kept — it is still the record of that pass.
    expect(state.processed.faces).toBe(42);
    // And the reconciliation is persisted, not just returned.
    expect(readScanState().running).toBe(false);
  });

  it("leaves a cleanly finished state alone", () => {
    writeScanState({
      ...emptyScanState(),
      running: false,
      eligible: 10,
      processed: { faces: 10 },
      startedAt: "2026-07-28T00:00:00.000Z",
      finishedAt: "2026-07-28T00:01:00.000Z",
    });
    const state = currentScanState();
    expect(state.error).toBeNull();
    expect(state.processed.faces).toBe(10);
  });

  it("stopping when nothing is running is a no-op", () => {
    expect(() => stopScan()).not.toThrow();
    expect(isScanning()).toBe(false);
  });
});

describe("workerBundlePath", () => {
  it("is a fixed, cwd-relative path with no env override", () => {
    // The absence of an override is deliberate: a path Turbopack cannot
    // constant-fold makes it trace the whole project into the route bundle.
    expect(workerBundlePath()).toBe(join(process.cwd(), ".vision", "scan-worker.mjs"));
    process.env.STARKEEP_PHOTOS_VISION_WORKER = "/somewhere/else.mjs";
    try {
      expect(workerBundlePath()).toBe(join(process.cwd(), ".vision", "scan-worker.mjs"));
    } finally {
      delete process.env.STARKEEP_PHOTOS_VISION_WORKER;
    }
  });
});
