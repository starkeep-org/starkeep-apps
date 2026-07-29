import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  enabledTaskIds,
  mergeVisionConfig,
  readVisionConfig,
  taskEnabled,
  writeVisionConfig,
} from "@/vision/config";
import { defaultVisionConfig, FACE_SIDECAR_VERSION, type FaceSidecar } from "@/vision/types";
import {
  FACE_DETECTOR_MODEL,
  FACE_EMBEDDER_MODEL,
  FACE_MODEL_ID,
  FACE_MODELS,
  FACE_MODELS_TOTAL_BYTES,
  modelStatus,
  modelStatusFor,
  SCENE_IMAGE_MODEL,
  taskModelPaths,
} from "@/vision/models";
import {
  configPath,
  faceSidecarPath,
  modelPath,
  modelsDir,
  sidecarPath,
  taskDir,
  visionAssetsDir,
  visionDir,
} from "@/vision/paths";
import {
  deleteFaceSidecar,
  deleteTaskSidecar,
  isCurrentFor,
  listSidecarRecordIds,
  listTaskRecordIds,
  processedRecordIds,
  readAllFaceSidecars,
  readFaceSidecar,
  readTaskSidecar,
  reapOrphanSidecars,
  taskProcessedRecordIds,
  taskSchema,
  writeFaceSidecar,
  writeTaskSidecar,
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

  it("keep the downloads out of the state tree", () => {
    // Losing app-local loses the user's clusters and labels; losing app-assets
    // costs a re-download. Only the second may be read out of the operator's
    // real ~/.starkeep under a test runner, so they cannot share a root.
    expect(visionAssetsDir()).toBe(join(root, "app-assets", "photos", "vision"));
    expect(visionAssetsDir().startsWith(visionDir())).toBe(false);
  });

  it("resolve the models with no STARKEEP_DIR, where state paths throw", () => {
    delete process.env.STARKEEP_DIR;
    expect(() => visionDir()).toThrow(/real Starkeep state directory/);
    expect(modelsDir()).toBe(join(homedir(), ".starkeep", "app-assets", "photos", "vision", "models"));
  });
});

describe("config", () => {
  it("defaults to everything off when there is no file", () => {
    expect(readVisionConfig()).toEqual(defaultVisionConfig());
    expect(readVisionConfig().faces.enabled).toBe(false);
    expect(readVisionConfig().faces.publishLabels).toBe(false);
  });

  it("round-trips a write", () => {
    const config = {
      faces: { enabled: true, threshold: 0.6, publishLabels: true },
      scene: { enabled: true },
    };
    writeVisionConfig(config);
    expect(readVisionConfig()).toEqual(config);
  });

  it("falls back to defaults on a corrupt file rather than throwing", () => {
    // A Settings panel that cannot render is a Settings panel that cannot be
    // used to fix the file it choked on.
    writeVisionConfig(defaultVisionConfig()); // creates the directory
    writeFileSync(configPath(), "{ not json", "utf-8");
    expect(readVisionConfig()).toEqual(defaultVisionConfig());
  });

  it("keeps unspecified fields when patching", () => {
    const base = {
      faces: { enabled: true, threshold: 0.6, publishLabels: true },
      scene: { enabled: true },
    };
    expect(mergeVisionConfig(base, { faces: { enabled: false } })).toEqual({
      faces: { enabled: false, threshold: 0.6, publishLabels: true },
      scene: { enabled: true },
    });
  });

  it("applies a patch that touches only one section, leaving the other alone", () => {
    // The regression the face-only merge would have shipped: it returned `base`
    // wholesale whenever `patch.faces` was absent, so a PUT touching only
    // `scene` was silently discarded while reporting success. Invisible with one
    // section; data loss with two.
    const base = {
      faces: { enabled: true, threshold: 0.6, publishLabels: true },
      scene: { enabled: false },
    };
    expect(mergeVisionConfig(base, { scene: { enabled: true } })).toEqual({
      faces: { enabled: true, threshold: 0.6, publishLabels: true },
      scene: { enabled: true },
    });
  });

  it("leaves every section alone for a patch that names none of them", () => {
    const base = defaultVisionConfig();
    expect(mergeVisionConfig(base, {})).toEqual(base);
    expect(mergeVisionConfig(base, null)).toEqual(base);
    expect(mergeVisionConfig(base, { nonsense: true })).toEqual(base);
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

describe("the generic task store", () => {
  it("keeps each task's sidecars in its own directory, named by task id", () => {
    // `faces/` is the path it already had — the refactor renamed the accessor,
    // not the store on disk, so an existing library is not re-scanned.
    expect(taskDir("faces")).toBe(join(visionDir(), "faces"));
    expect(sidecarPath("faces", "rec")).toBe(faceSidecarPath("rec"));
  });

  it("round-trips through the generic accessors", () => {
    writeTaskSidecar("faces", "rec-1", sidecar({ w: 800, h: 600 }));
    expect(readTaskSidecar("faces", "rec-1")).toMatchObject({ w: 800, h: 600 });
    expect(listTaskRecordIds("faces")).toEqual(["rec-1"]);
    expect(taskProcessedRecordIds("faces").has("rec-1")).toBe(true);
    deleteTaskSidecar("faces", "rec-1");
    expect(readTaskSidecar("faces", "rec-1")).toBeNull();
  });

  it("rejects a sidecar carrying another task's payload", () => {
    // The only thing that would notice a task directory being read as the wrong
    // task's: the file name is just `<recordId>.json` either way.
    writeTaskSidecar("faces", "rec-alien", {
      v: FACE_SIDECAR_VERSION,
      model: FACE_MODEL_ID,
      processedAt: "2026-07-28T00:00:00.000Z",
      w: 10,
      h: 10,
    });
    expect(readTaskSidecar("faces", "rec-alien")).toBeNull();
    expect(taskProcessedRecordIds("faces").has("rec-alien")).toBe(false);
  });

  it("judges staleness against the task's own version and model", () => {
    const schema = taskSchema("faces");
    expect(schema).toEqual({ version: FACE_SIDECAR_VERSION, modelId: FACE_MODEL_ID });
    expect(isCurrentFor("faces", sidecar())).toBe(true);
    expect(isCurrentFor("faces", sidecar({ model: "some-older-pair" }))).toBe(false);
    expect(isCurrentFor("faces", sidecar({ v: FACE_SIDECAR_VERSION - 1 }))).toBe(false);
  });

  it("reports an unscanned task as having processed nothing", () => {
    // The check that matters when a second task is enabled on an already-scanned
    // library: a shared processed-set would report every record done and skip
    // the entire pass.
    writeTaskSidecar("faces", "rec-1", sidecar());
    expect(taskProcessedRecordIds("faces").size).toBe(1);
    expect(listTaskRecordIds("faces")).toEqual(["rec-1"]);
  });
});

describe("enabled tasks and their models", () => {
  it("reports nothing enabled by default", () => {
    expect(enabledTaskIds(defaultVisionConfig())).toEqual([]);
  });

  it("reports each task enabled independently, in registry order", () => {
    const facesOnly = {
      faces: { enabled: true, threshold: 0.45, publishLabels: false },
      scene: { enabled: false },
    };
    expect(enabledTaskIds(facesOnly)).toEqual(["faces"]);
    expect(taskEnabled(facesOnly, "faces")).toBe(true);
    expect(taskEnabled(facesOnly, "scene")).toBe(false);

    const sceneOnly = {
      faces: { enabled: false, threshold: 0.45, publishLabels: false },
      scene: { enabled: true },
    };
    expect(enabledTaskIds(sceneOnly)).toEqual(["scene"]);

    const both = { ...facesOnly, scene: { enabled: true } };
    // `VISION_TASK_IDS` order, not config key order — the host's gate and the
    // worker's task list both derive from it and must agree.
    expect(enabledTaskIds(both)).toEqual(["faces", "scene"]);
  });

  it("asks for no models when no task is enabled", () => {
    // What keeps a scene-only pass from being refused for want of the 278 MB of
    // face weights it was never going to open.
    expect(modelStatusFor([])).toMatchObject({ installed: true, missing: [], missingBytes: 0 });
  });

  it("gates a scene-only scan on the scene weights alone", () => {
    // The §3.2 property, now actually observable: enabling scene must not demand
    // the face pair, and vice versa.
    expect(modelStatusFor(["scene"]).missing).toEqual([SCENE_IMAGE_MODEL.fileName]);
    expect(modelStatusFor(["faces"]).missing).not.toContain(SCENE_IMAGE_MODEL.fileName);
  });

  it("names a task's own missing models", () => {
    const status = modelStatusFor(["faces"]);
    expect(status).toEqual(modelStatus("faces"));
    expect(status.missing).toEqual(FACE_MODELS.map((m) => m.fileName));
    expect(status.missingBytes).toBe(FACE_MODELS_TOTAL_BYTES);
  });

  it("resolves a task's model paths by the role its engine asks for", () => {
    const paths = taskModelPaths("faces");
    expect(Object.keys(paths).sort()).toEqual(["detector", "embedder"]);
    expect(paths.detector).toBe(modelPath(FACE_DETECTOR_MODEL.fileName));
    expect(paths.embedder).toBe(modelPath(FACE_EMBEDDER_MODEL.fileName));
  });
});

describe("reapOrphanSidecars", () => {
  it("drops sidecars for records that are no longer in the scan set", () => {
    writeFaceSidecar("lives", sidecar());
    writeFaceSidecar("gone", sidecar());
    expect(reapOrphanSidecars(new Set(["lives"]))).toEqual(["gone"]);
    expect(listSidecarRecordIds()).toEqual(["lives"]);
  });

  it("reaps a stale-model sidecar too", () => {
    // The reap works off `listSidecarRecordIds`, not `readAllFaceSidecars` — a
    // sidecar this build would rewrite is still a sidecar taking up a record id,
    // and leaving it would mean orphans that only a model swap could clear.
    writeFaceSidecar("gone-old", sidecar({ model: "some-older-pair" }));
    expect(reapOrphanSidecars(new Set(["lives"]))).toEqual(["gone-old"]);
    expect(listSidecarRecordIds()).toEqual([]);
  });

  it("keeps everything when the scan set covers the store", () => {
    writeFaceSidecar("a", sidecar());
    writeFaceSidecar("b", sidecar());
    expect(reapOrphanSidecars(new Set(["a", "b", "never-scanned"]))).toEqual([]);
    expect(listSidecarRecordIds().sort()).toEqual(["a", "b"]);
  });

  it("is a no-op on an empty store rather than throwing", () => {
    expect(reapOrphanSidecars(new Set(["a"]))).toEqual([]);
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
