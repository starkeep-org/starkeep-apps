/**
 * The vision task registry.
 *
 * One entry today. It exists in this shape because the follow-on tasks —
 * objects (RT-DETR) and scene (CLIP), plan §7 — differ from faces only in which
 * models they load and what they write; the scan loop, the sidecar-as-
 * processed-marker, and the per-task progress counters are identical. Keeping
 * that seam here is what makes them additive instead of a second scan pass.
 *
 * ⚠ Engine-side: not reachable from `app/`. See `face-engine.ts`.
 */

import type { FaceEngine } from "./face-engine";
import { encodeEmbedding } from "../embeddings";
import { FACE_MODEL_ID } from "../models";
import { FACE_SIDECAR_VERSION, type FaceSidecar, type VisionTaskId } from "../types";
import { isCurrent, readFaceSidecar, writeFaceSidecar } from "../sidecars";

export interface VisionTask {
  id: VisionTaskId;
  /** Does the current config ask for this task at all? */
  enabled(config: { faces: { enabled: boolean } }): boolean;
  /** Has this record already been processed by the *current* models? */
  isProcessed(recordId: string): boolean;
  /**
   * Run the task and persist its sidecar. Takes decoded bytes, never storage —
   * the property that keeps the engine extractable (plan §9).
   */
  run(recordId: string, bytes: Uint8Array): Promise<void>;
}

export function faceTask(engine: FaceEngine): VisionTask {
  return {
    id: "faces",
    enabled: (config) => config.faces.enabled,
    isProcessed: (recordId) => {
      const sidecar = readFaceSidecar(recordId);
      return sidecar !== null && isCurrent(sidecar);
    },
    run: async (recordId, bytes) => {
      const result = await engine.analyze(bytes);
      const sidecar: FaceSidecar = {
        v: FACE_SIDECAR_VERSION,
        model: FACE_MODEL_ID,
        processedAt: new Date().toISOString(),
        w: result.width,
        h: result.height,
        // A record with no faces still gets a sidecar. That is the difference
        // between a scan that converges and one that re-runs the same empty
        // photos on every pass.
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
      writeFaceSidecar(recordId, sidecar);
    },
  };
}
