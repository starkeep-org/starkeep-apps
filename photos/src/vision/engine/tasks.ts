/**
 * The vision task registry.
 *
 * One entry today. It exists in this shape because the follow-on tasks —
 * objects (RT-DETR) and scene (CLIP) — differ from faces only in which models
 * they load and what they write; the scan loop, the sidecar-as-processed-marker,
 * and the per-task progress counters are identical. Keeping that seam here is
 * what makes them additive instead of a second scan pass.
 *
 * **Engines are created lazily, by the task, from a path map.** Not a detail:
 * the worker used to construct `FaceEngine` — 278 MB of ONNX — before it looked
 * at which tasks were enabled, so a scene-only pass loaded and discarded a
 * quarter-gigabyte. `create()` is therefore separate from the descriptor, and
 * the worker calls it only for tasks that survive the enabled filter and only
 * once it knows there is work.
 *
 * ⚠ Engine-side: not reachable from `app/`. See `face-engine.ts`.
 */

import { FaceEngine } from "./face-engine";
import { SceneEngine } from "./siglip";
import { encodeEmbedding } from "../embeddings";
import { taskEnabled } from "../config";
import { FACE_MODEL_ID, SCENE_MODEL_ID } from "../models";
import {
  FACE_SIDECAR_VERSION,
  SCENE_SIDECAR_VERSION,
  VISION_TASK_IDS,
  type FaceSidecar,
  type SceneSidecar,
  type VisionConfig,
  type VisionTaskId,
} from "../types";
import { isCurrentFor, readTaskSidecar, writeTaskSidecar } from "../sidecars";
import type { TaskModelPaths } from "../worker-protocol";

/** A task with its models loaded, ready to run over images. */
export interface VisionTask {
  id: VisionTaskId;
  /** Run the task and persist its sidecar. */
  run(recordId: string, bytes: Uint8Array): Promise<void>;
  /** Release the ONNX sessions. Called once per pass, per task that loaded. */
  dispose(): Promise<void>;
}

/**
 * A task before its models are loaded — cheap, so the worker can ask
 * `isProcessed` and skip a whole pass without opening a graph.
 */
export interface VisionTaskSpec {
  id: VisionTaskId;
  /** Has this record already been processed by the *current* models? */
  isProcessed(recordId: string): boolean;
  /**
   * Load the models and return the runnable task. Takes decoded bytes when it
   * runs, never storage — the property that keeps the engine extractable.
   */
  create(models: TaskModelPaths): Promise<VisionTask>;
}

const SPECS: Record<VisionTaskId, VisionTaskSpec> = {
  scene: {
    id: "scene",
    isProcessed: (recordId) => {
      const sidecar = readTaskSidecar("scene", recordId);
      return sidecar !== null && isCurrentFor("scene", sidecar);
    },
    create: async (models) => {
      const engine = await SceneEngine.create({ imagePath: required(models, "image") });
      return {
        id: "scene",
        dispose: () => engine.dispose(),
        run: async (recordId, bytes) => {
          const result = await engine.embed(bytes);
          const sidecar: SceneSidecar = {
            v: SCENE_SIDECAR_VERSION,
            model: SCENE_MODEL_ID,
            processedAt: new Date().toISOString(),
            w: result.width,
            h: result.height,
            embedding: encodeEmbedding(result.embedding),
          };
          writeTaskSidecar("scene", recordId, sidecar);
        },
      };
    },
  },
  faces: {
    id: "faces",
    isProcessed: (recordId) => {
      const sidecar = readTaskSidecar("faces", recordId);
      return sidecar !== null && isCurrentFor("faces", sidecar);
    },
    create: async (models) => {
      const engine = await FaceEngine.create({
        detectorPath: required(models, "detector"),
        embedderPath: required(models, "embedder"),
      });
      return {
        id: "faces",
        dispose: () => engine.dispose(),
        run: async (recordId, bytes) => {
          const result = await engine.analyze(bytes);
          const sidecar: FaceSidecar = {
            v: FACE_SIDECAR_VERSION,
            model: FACE_MODEL_ID,
            processedAt: new Date().toISOString(),
            w: result.width,
            h: result.height,
            // A record with no faces still gets a sidecar. That is the
            // difference between a scan that converges and one that re-runs the
            // same empty photos on every pass.
            faces: result.faces.map((face) => ({
              bbox: face.bbox,
              score: face.score,
              kps: face.kps,
              embedding: encodeEmbedding(face.embedding),
              // Assignment happens after the pass, over the whole store, so a
              // stopped scan never leaves half a cluster behind.
              personId: null,
            })),
          };
          writeTaskSidecar("faces", recordId, sidecar);
        },
      };
    },
  },
};

/**
 * The specs the config asks for.
 *
 * Mirrors `enabledTaskIds` on the host side rather than trusting the command:
 * the host gates on the same config, so the two agreeing is a property worth
 * having redundantly — a worker that ran a task the host did not gate for would
 * be one whose models were never checked.
 */
export function enabledTaskSpecs(config: VisionConfig): VisionTaskSpec[] {
  return VISION_TASK_IDS.filter((id) => taskEnabled(config, id)).map((id) => SPECS[id]);
}

function required(models: TaskModelPaths, role: string): string {
  const path = models[role];
  if (!path) throw new Error(`the start command carries no "${role}" model path`);
  return path;
}
