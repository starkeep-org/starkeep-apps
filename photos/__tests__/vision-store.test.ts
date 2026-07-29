import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeVisionConfig, readVisionConfig, writeVisionConfig } from "@/vision/config";
import { defaultVisionConfig, FACE_SIDECAR_VERSION, type FaceSidecar } from "@/vision/types";
import { FACE_MODEL_ID } from "@/vision/models";
import { configPath, faceSidecarPath, visionDir } from "@/vision/paths";
import {
  deleteFaceSidecar,
  listSidecarRecordIds,
  processedRecordIds,
  readAllFaceSidecars,
  readFaceSidecar,
  writeFaceSidecar,
} from "@/vision/sidecars";
import { readScanState, writeScanState } from "@/vision/scan-state";

let root: string;
let previousDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "starkeep-vision-"));
  previousDir = process.env.STARKEEP_DIR;
  // starkeepDir() reads the env on every call, so pointing it at a temp root is
  // all the isolation these tests need.
  process.env.STARKEEP_DIR = root;
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.STARKEEP_DIR;
  else process.env.STARKEEP_DIR = previousDir;
  rmSync(root, { recursive: true, force: true });
});

function sidecar(overrides: Partial<FaceSidecar> = {}): FaceSidecar {
  return {
    v: FACE_SIDECAR_VERSION,
    model: FACE_MODEL_ID,
    processedAt: "2026-07-28T00:00:00.000Z",
    w: 100,
    h: 100,
    faces: [],
    ...overrides,
  };
}

describe("vision paths", () => {
  it("live under app-local, outside both syncing homes", () => {
    // The whole storage decision in one assertion: not `shared/…`, not
    // `apps/photos/syncable/…`, both of which sync unconditionally.
    expect(visionDir()).toBe(join(root, "app-local", "photos", "vision"));
    expect(visionDir()).not.toContain("syncable");
  });
});

describe("config", () => {
  it("defaults to everything off when there is no file", () => {
    expect(readVisionConfig()).toEqual(defaultVisionConfig());
    expect(readVisionConfig().faces.enabled).toBe(false);
    expect(readVisionConfig().faces.publishLabels).toBe(false);
  });

  it("round-trips a write", () => {
    writeVisionConfig({ faces: { enabled: true, threshold: 0.6, publishLabels: true } });
    expect(readVisionConfig()).toEqual({
      faces: { enabled: true, threshold: 0.6, publishLabels: true },
    });
  });

  it("falls back to defaults on a corrupt file rather than throwing", () => {
    // A Settings panel that cannot render is a Settings panel that cannot be
    // used to fix the file it choked on.
    writeVisionConfig(defaultVisionConfig()); // creates the directory
    writeFileSync(configPath(), "{ not json", "utf-8");
    expect(readVisionConfig()).toEqual(defaultVisionConfig());
  });

  it("keeps unspecified fields when patching", () => {
    const base = { faces: { enabled: true, threshold: 0.6, publishLabels: true } };
    expect(mergeVisionConfig(base, { faces: { enabled: false } })).toEqual({
      faces: { enabled: false, threshold: 0.6, publishLabels: true },
    });
  });

  it("clamps the threshold into a usable band", () => {
    const base = defaultVisionConfig();
    // At 0 every face joins the first cluster; at 1 nothing ever matches. Both
    // present as "clustering silently stopped working".
    expect(mergeVisionConfig(base, { faces: { threshold: 0 } }).faces.threshold).toBe(0.1);
    expect(mergeVisionConfig(base, { faces: { threshold: 5 } }).faces.threshold).toBe(0.95);
    expect(mergeVisionConfig(base, { faces: { threshold: NaN } }).faces.threshold).toBe(0.45);
  });
});

describe("sidecars", () => {
  it("round-trips a sidecar", () => {
    writeFaceSidecar("rec-1", sidecar({ w: 640, h: 480 }));
    expect(readFaceSidecar("rec-1")).toMatchObject({ w: 640, h: 480, faces: [] });
  });

  it("treats a zero-face sidecar as processed", () => {
    // The distinction the whole scan loop depends on: "processed, found
    // nothing" must not look like "not processed yet".
    writeFaceSidecar("rec-empty", sidecar());
    expect(processedRecordIds().has("rec-empty")).toBe(true);
  });

  it("treats a stale-model sidecar as unprocessed", () => {
    writeFaceSidecar("rec-old", sidecar({ model: "some-older-pair" }));
    expect(listSidecarRecordIds()).toContain("rec-old");
    expect(processedRecordIds().has("rec-old")).toBe(false);
    expect(readAllFaceSidecars().has("rec-old")).toBe(false);
  });

  it("treats an older sidecar version as unprocessed", () => {
    writeFaceSidecar("rec-v0", sidecar({ v: FACE_SIDECAR_VERSION - 1 }));
    expect(processedRecordIds().has("rec-v0")).toBe(false);
  });

  it("ignores a truncated sidecar instead of reading it as zero faces", () => {
    writeFaceSidecar("rec-bad", sidecar());
    writeFileSync(faceSidecarPath("rec-bad"), '{"v":1,"model":"x","fa', "utf-8");
    expect(readFaceSidecar("rec-bad")).toBeNull();
    expect(processedRecordIds().has("rec-bad")).toBe(false);
  });

  it("returns an empty set before anything has been scanned", () => {
    expect(listSidecarRecordIds()).toEqual([]);
    expect(processedRecordIds().size).toBe(0);
  });

  it("deletes a sidecar and forgets it was processed", () => {
    writeFaceSidecar("rec-2", sidecar());
    deleteFaceSidecar("rec-2");
    expect(readFaceSidecar("rec-2")).toBeNull();
    expect(listSidecarRecordIds()).toEqual([]);
  });
});

describe("scan state", () => {
  it("reads as an empty state before the first pass", () => {
    expect(readScanState()).toMatchObject({ running: false, eligible: 0, processed: {} });
  });

  it("round-trips per-task counters", () => {
    writeScanState({
      running: true,
      eligible: 10,
      skipped: 2,
      processed: { faces: 7 },
      failed: 1,
      startedAt: "2026-07-28T00:00:00.000Z",
      finishedAt: null,
      error: null,
    });
    expect(readScanState().processed.faces).toBe(7);
    expect(readScanState().running).toBe(true);
  });
});
