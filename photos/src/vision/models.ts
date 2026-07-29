/**
 * The ONNX graphs the face task needs, and whether they are on disk.
 *
 * **Licence.** InsightFace's *code* is MIT, but the antelopev2 pretrained
 * weights — like every InsightFace model card — are released for
 * **non-commercial research use only**
 * (https://github.com/deepinsight/insightface/issues/2022). That is fine for
 * starkeep and is why nothing here downloads anything implicitly: the fetch
 * script requires an explicit acknowledgement, and the app shows a
 * "models not installed" state until it has been run.
 *
 * Only two of antelopev2's five files are used. `1k3d68` (dense 3D landmarks),
 * `2d106det`, and `genderage` are not fetched — 150 MB we would never call.
 *
 * Sizes and digests come from the pack's Hugging Face mirror; the URL is pinned
 * to a commit, not to `main`, so "same URL" means "same bytes" independently of
 * the digest check.
 */

import { statSync } from "node:fs";
import { modelPath, modelsDir } from "./paths";

const HF_REPO = "Aitrepreneur/insightface";
/** Pinned commit of the mirror repo — see the module comment. */
const HF_REVISION = "fd887cdef0c73f32251198b8160d6771ac413fc0";

export interface VisionModel {
  fileName: string;
  url: string;
  /** SHA-256 of the file's bytes (Git-LFS oid on the mirror). */
  sha256: string;
  sizeBytes: number;
  role: string;
}

function antelopev2(fileName: string, sha256: string, sizeBytes: number, role: string): VisionModel {
  return {
    fileName,
    url: `https://huggingface.co/${HF_REPO}/resolve/${HF_REVISION}/models/antelopev2/${fileName}`,
    sha256,
    sizeBytes,
    role,
  };
}

export const FACE_DETECTOR_MODEL = antelopev2(
  "scrfd_10g_bnkps.onnx",
  "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
  16_923_827,
  "face detection + 5 keypoints",
);

export const FACE_EMBEDDER_MODEL = antelopev2(
  "glintr100.onnx",
  "4ab1d6435d639628a6f3e5008dd4f929edf4c4124b1a7169e1048f9fef534cdf",
  260_665_334,
  "512-d identity embedding",
);

export const FACE_MODELS: VisionModel[] = [FACE_DETECTOR_MODEL, FACE_EMBEDDER_MODEL];

/**
 * Identifies the model pair a sidecar was produced by. A sidecar whose `model`
 * does not equal this is stale and gets reprocessed — which is how swapping in
 * the lighter `scrfd_2.5g` / `w600k_r50` pair later invalidates old results
 * without a migration.
 */
export const FACE_MODEL_ID = "antelopev2:scrfd_10g_bnkps+glintr100";

/**
 * What the pack is called, for a UI that has to name what it installed.
 *
 * Kept beside `FACE_MODEL_ID` rather than parsed out of it: that id is written
 * into every sidecar on disk and is matched literally, so it stays a literal —
 * greppable, and impossible to change by accident. `vision-models.test.ts` pins
 * the two to each other.
 */
export const FACE_MODEL_PACK = "antelopev2";

/** The whole pair, installed or not — what the badge reports once it is. */
export const FACE_MODELS_TOTAL_BYTES = FACE_MODELS.reduce((sum, m) => sum + m.sizeBytes, 0);

export interface ModelInstallStatus {
  installed: boolean;
  dir: string;
  missing: string[];
  /** What an install would have to transfer — what the panel quotes up front. */
  missingBytes: number;
}

/**
 * Are the face models on disk?
 *
 * Size, not digest: re-hashing 278 MB on every status poll would make the
 * Settings panel unusable. The digest is verified once, at fetch time, which is
 * where it matters — this check only has to tell a fetched file from a missing
 * or truncated one.
 */
export function faceModelStatus(): ModelInstallStatus {
  const missing: string[] = [];
  let missingBytes = 0;
  for (const model of FACE_MODELS) {
    try {
      if (statSync(modelPath(model.fileName)).size !== model.sizeBytes) {
        missing.push(model.fileName);
        missingBytes += model.sizeBytes;
      }
    } catch {
      missing.push(model.fileName);
      missingBytes += model.sizeBytes;
    }
  }
  return { installed: missing.length === 0, dir: modelsDir(), missing, missingBytes };
}
