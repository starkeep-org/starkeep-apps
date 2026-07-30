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
import type { VisionTaskId } from "./types";
import type { TaskModelPaths } from "./worker-protocol";

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

// ---------------------------------------------------------------------------
// Scene: SigLIP 2 so400m/16-384.
//
// **Licence: Apache-2.0** — upstream is `google/siglip2-so400m-patch16-384`.
// Unlike antelopev2 this carries no non-commercial restriction, so it needs no
// acknowledgement gate; `licence.ts` stays face-specific on purpose.
//
// Chosen for retrieval rather than tagging, which is why it is not the ViT-B/32
// the face plan pre-settled — see `vision-model-choice.md` for the full
// comparison. Two signals agreed: published text→image retrieval rankings, and
// Immich (a self-hosted personal-photo app, i.e. this exact problem) shipping
// this family as its high-end option.
//
// The export is the transformers.js one rather than Immich's own, for a dull but
// decisive reason: Immich's OpenCLIP-format text tower is scattered across
// *hundreds* of external-data blobs, one per weight tensor, which `VisionModel`'s
// one-URL-one-digest shape cannot express. This export is one file per tower.
//
// Only the **image** tower is listed as the scene task's model. The text tower is
// search's, loaded by the query worker, and gating a scan on it would refuse a
// pass for want of a graph it never opens — the same mistake §3.2 removed.
// ---------------------------------------------------------------------------

const SIGLIP_REPO = "onnx-community/siglip2-so400m-patch16-384-ONNX";
/** Pinned commit, so "same URL" means "same bytes" independently of the digest. */
const SIGLIP_REVISION = "29f74e673c298fd07482d8e20138179282001eb7";

function siglip(path: string, sha256: string, sizeBytes: number, role: string): VisionModel {
  return {
    fileName: path.split("/").pop() as string,
    url: `https://huggingface.co/${SIGLIP_REPO}/resolve/${SIGLIP_REVISION}/${path}`,
    sha256,
    sizeBytes,
    role,
  };
}

/**
 * fp32, not int8. This is the one graph whose output is *persisted* — the
 * embedding lands in a sidecar and every search ranks against it — so there is no
 * reason to quantize away quality on it when compute is not the binding
 * constraint. Contrast the text tower, whose precision is freely revisable
 * because nothing it produces is stored.
 */
export const SCENE_IMAGE_MODEL = siglip(
  "onnx/vision_model.onnx",
  "e3f730b2a37c69ac08c2159fe3c7fab97f23fbe3f32319f9953375ba82ecb1e6",
  1_713_609_535,
  "whole-image embedding (SigLIP 2 so400m/16-384)",
);

export const SCENE_MODELS: VisionModel[] = [SCENE_IMAGE_MODEL];

/**
 * Identifies the model a scene sidecar was produced by. A sidecar whose `model`
 * does not equal this is stale and gets reprocessed — per-task since the step-1
 * refactor, so changing this invalidates **scene** results and leaves faces
 * untouched.
 *
 * The precision is part of the id: embeddings from the fp32 and int8 towers are
 * close but not identical, and an index mixing the two would rank against
 * subtly inconsistent vectors. Dropping to int8 is therefore a reprocess, which
 * is the honest cost and is what this literal makes unavoidable.
 */
export const SCENE_MODEL_ID = "siglip2-so400m-patch16-384:vision-fp32";

export const SCENE_MODEL_PACK = "siglip2-so400m-patch16-384";

/** Licence of the scene weights, for a UI that names what it installed. */
export const SCENE_LICENCE_SUMMARY = "Apache-2.0";

export const SCENE_MODELS_TOTAL_BYTES = SCENE_MODELS.reduce((sum, m) => sum + m.sizeBytes, 0);

/**
 * What the image tower expects, from the export's `preprocessor_config.json`.
 *
 * Worth pinning as named constants because SigLIP differs from CLIP in two ways
 * that fail silently if assumed: it **squashes to a square** rather than resizing
 * the short side and centre-cropping, and it normalizes to [−1, 1] with
 * mean/std 0.5 rather than using ImageNet statistics. Either mistake yields
 * embeddings that are plausible, self-consistent, and quietly worse.
 */
export const SCENE_INPUT_SIZE = 384;
export const SCENE_MEAN = 127.5;
export const SCENE_STD = 127.5;
/** Projection width of both towers — the dimension stored in every sidecar. */
export const SCENE_EMBEDDING_DIM = 1152;

// ---------------------------------------------------------------------------
// Search: the same model's *text* tower, plus its tokenizer.
//
// Separate from `SCENE_MODELS` on purpose. The scan never opens these, so gating
// a scan on them would refuse a pass for want of a graph it does not use — and
// conversely, search needs them without needing the 1.7 GB image tower present.
// They are the *search feature's* models, checked by the query worker.
//
// **int8, unlike the image tower**, and the asymmetry is deliberate rather than
// inconsistent:
//
//   - Nothing this tower produces is persisted. It turns a live query into a
//     vector; the stored index comes entirely from the image tower. So its
//     precision is not pinned into any sidecar and can change with no reprocess.
//   - It is held **resident** by the query worker between searches (§6), where
//     fp32 means 2.8 GB of RAM for a search box. §6's open worry is a background
//     tab holding ~65 MB forever; 2.8 GB is not a variation on that concern, it
//     is a different one.
//   - fp32 also needs external data (a 599 KB graph plus a 2831 MB
//     `.onnx_data` sibling) where int8 is one self-contained file.
//
// `pnpm vision:compare-text-towers` measures what that costs in ranking terms,
// because the honest answer to "how much retrieval quality does int8 lose" is a
// measurement, not a prior. `SEARCH_TEXT_MODEL_FP32` exists for it to compare
// against, and swapping the pin below is the whole cost of changing our mind.
// ---------------------------------------------------------------------------

export const SEARCH_TEXT_MODEL = siglip(
  "onnx/text_model_int8.onnx",
  "96bb04c4987f7e0d35ae64c4ef1a3121f833c2d0ad95faaae223c59dbbdd639c",
  711_126_655,
  "text query embedding (SigLIP 2 so400m text tower, int8)",
);

/**
 * The Gemma tokenizer, as a HuggingFace `tokenizer.json`.
 *
 * A model file in every sense that matters here: pinned, verified, and required
 * at query time. **BPE with byte fallback over a 256 k vocabulary** — not the
 * sentencepiece Unigram the plan's §4.1 and an earlier draft of
 * `vision-model-choice.md` assumed. `tokenizer.json` is the authority and
 * `search/tokenizer.ts` implements exactly what it declares.
 */
export const SEARCH_TOKENIZER = siglip(
  "tokenizer.json",
  "cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322",
  34_363_039,
  "Gemma BPE tokenizer (256k vocab, 580k merges)",
);

export const SEARCH_MODELS: VisionModel[] = [SEARCH_TEXT_MODEL, SEARCH_TOKENIZER];

export const SEARCH_MODELS_TOTAL_BYTES = SEARCH_MODELS.reduce((sum, m) => sum + m.sizeBytes, 0);

/**
 * The fp32 text tower, for `vision:compare-text-towers` only.
 *
 * Never loaded by the app. Note it is the small half of a pair — ORT resolves
 * `text_model.onnx_data` beside it — which is the other reason the shipped pin is
 * int8: `VisionModel` describes one file, and a two-file graph does not fit it
 * without a manifest.
 */
export const SEARCH_TEXT_MODEL_FP32 = siglip(
  "onnx/text_model.onnx",
  "1be6a35f94aa0d1aa15024569ccb7637c7157809624922e50e22d746d43745a5",
  599_026,
  "text tower, fp32 (needs text_model.onnx_data alongside)",
);

export const SEARCH_TEXT_DATA_FP32 = siglip(
  "onnx/text_model.onnx_data",
  "80d50b22c6a56758717e6acdbf03f3e564b3a701d152b6741d8b62181cae7983",
  2_831_131_584,
  "external weights for the fp32 text tower",
);

/**
 * Tokens the text tower expects, exactly. From `tokenizer.json`'s `padding`
 * block and `post_processor`.
 *
 * The length is **fixed, not a maximum**: SigLIP pads every sequence to 64 and
 * was trained that way, so feeding a shorter tensor is not "more efficient", it
 * is a different input distribution.
 */
export const SEARCH_TEXT_TOKENS = 64;
export const SEARCH_PAD_ID = 0;
export const SEARCH_EOS_ID = 1;

/** Is the search feature's own model set installed? */
export function searchModelStatus(): ModelInstallStatus {
  return statusOf(SEARCH_MODELS);
}


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

// ---------------------------------------------------------------------------
// Objects: RT-DETRv2 R101.
//
// **Licence: Apache-2.0** — upstream is `PekingU/rtdetr_v2_r101vd`.
//
// Smaller work than the face path, not larger, exactly as §9 predicted: the DETR
// family emits set predictions directly, so there is no anchor grid, no stride
// decoding, and **no NMS** — which is most of what `scrfd.ts` is — and nothing
// downstream, since objects need no alignment, no embedding, no clustering, and no
// naming UI.
//
// ⚠ **Two details where §9 describes DETR and this model is RT-DETR.** Both fail
// silently if taken on trust, so both are pinned here and asserted in
// `vision-objects.test.ts` against the graph itself:
//
//   1. §9 says "softmax over logits, drop the no-object class". RT-DETR has **no
//      no-object class** — 80 contiguous logits — and is trained with a focal loss,
//      so scores come from a **per-class sigmoid**, not a softmax over 81. Using
//      softmax would renormalize away the very signal the threshold reads.
//   2. §9 says "resize + ImageNet normalization". The export's
//      `preprocessor_config.json` says `do_normalize: false` — only a ÷255 rescale,
//      despite the file also carrying ImageNet mean/std values it does not apply.
//      Subtracting them anyway shifts every input off the trained distribution.
// ---------------------------------------------------------------------------

const RTDETR_REPO = "onnx-community/rtdetr_v2_r101vd-ONNX";
const RTDETR_REVISION = "20760ebd6e97f223ce139bcf9c30ba993dfe953b";

/**
 * fp32, like the scene tower and for the same reason: its output is persisted, so
 * there is no reason to quantize away precision when compute is not the binding
 * constraint. R101 rather than R50 for the couple of AP points, which cost only
 * download size here.
 */
export const OBJECT_DETECTOR_MODEL: VisionModel = {
  fileName: "rtdetr_v2_r101vd.onnx",
  url: `https://huggingface.co/${RTDETR_REPO}/resolve/${RTDETR_REVISION}/onnx/model.onnx`,
  sha256: "238e94ddfdf6b478968e9bb4157bb49456bf384e61ad284646820fd06f650be2",
  sizeBytes: 307_282_575,
  role: "object detection (COCO-80 boxes and classes)",
};

export const OBJECT_MODELS: VisionModel[] = [OBJECT_DETECTOR_MODEL];

/**
 * Identifies the model an object sidecar was produced by — per-task, so changing
 * it reprocesses **objects** and leaves faces and scene alone.
 */
export const OBJECT_MODEL_ID = "rtdetr_v2_r101vd:fp32";

export const OBJECT_MODEL_PACK = "rtdetr-v2-r101vd";

export const OBJECT_MODELS_TOTAL_BYTES = OBJECT_MODELS.reduce((sum, m) => sum + m.sizeBytes, 0);

/**
 * What the detector expects, from the export's `preprocessor_config.json` and the
 * probed graph.
 *
 * `do_pad: false` and a flat 640×640 `size` mean it **squashes** rather than
 * letterboxing — unlike SCRFD, which pads at the top-left and needs its boxes
 * scaled back by one factor. Squashing means two independent scale factors, which
 * is simpler but only if nobody assumes otherwise.
 */
export const OBJECT_INPUT_SIZE = 640;
/** 300 set predictions per image, whatever the image contains. */
export const OBJECT_QUERIES = 300;
export const OBJECT_CLASS_COUNT = 80;

/**
 * Which graphs each task needs.
 *
 * `Record` over the id union, so a new task cannot be added without saying what
 * it downloads — a task whose models nobody checks starts a scan that fails
 * inside the worker on a missing file, well past the point where the UI could
 * have said "not installed".
 */
export const TASK_MODELS: Record<VisionTaskId, VisionModel[]> = {
  faces: FACE_MODELS,
  scene: SCENE_MODELS,
  objects: OBJECT_MODELS,
};

/**
 * Where a task's graphs are, keyed by the role name that task's engine asks for.
 *
 * The one place that knows both a task's roles and the on-disk layout. Resolved
 * host-side and passed on the start command, so the worker owns no path policy
 * (`worker-protocol.ts`).
 */
export function taskModelPaths(taskId: VisionTaskId): TaskModelPaths {
  switch (taskId) {
    case "faces":
      return {
        detector: modelPath(FACE_DETECTOR_MODEL.fileName),
        embedder: modelPath(FACE_EMBEDDER_MODEL.fileName),
      };
    case "scene":
      return { image: modelPath(SCENE_IMAGE_MODEL.fileName) };
    case "objects":
      return { detector: modelPath(OBJECT_DETECTOR_MODEL.fileName) };
  }
}

export interface ModelInstallStatus {
  installed: boolean;
  dir: string;
  missing: string[];
  /** What an install would have to transfer — what the panel quotes up front. */
  missingBytes: number;
}

/**
 * Are a task's models on disk?
 *
 * Size, not digest: re-hashing 278 MB on every status poll would make the
 * Settings panel unusable. The digest is verified once, at fetch time, which is
 * where it matters — this check only has to tell a fetched file from a missing
 * or truncated one.
 */
export function modelStatus(taskId: VisionTaskId): ModelInstallStatus {
  return statusOf(TASK_MODELS[taskId]);
}

/**
 * The same check folded over several tasks, for the gate on starting a scan.
 *
 * Deduplicated by file name: two tasks are free to share a graph, and quoting
 * its bytes twice would make the panel promise a download twice the size of the
 * one it performs.
 */
export function modelStatusFor(taskIds: readonly VisionTaskId[]): ModelInstallStatus {
  const seen = new Map<string, VisionModel>();
  for (const taskId of taskIds) {
    for (const model of TASK_MODELS[taskId]) seen.set(model.fileName, model);
  }
  return statusOf([...seen.values()]);
}

function statusOf(models: readonly VisionModel[]): ModelInstallStatus {
  const missing: string[] = [];
  let missingBytes = 0;
  for (const model of models) {
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

/** The face task's spelling, for the face-specific call sites and the fetch script. */
export function faceModelStatus(): ModelInstallStatus {
  return modelStatus("faces");
}


// ---------------------------------------------------------------------------
// Download groups
// ---------------------------------------------------------------------------

/**
 * What a user can choose to install, as one unit.
 *
 * Grouped by *what needs them* rather than by task, because `search` is not a
 * vision task — the scan never opens the text tower — and because the groups have
 * different **licences**, which is the property that must not be flattened: the
 * antelopev2 acknowledgement has to gate only the weights it applies to, or
 * accepting a non-commercial restriction becomes the price of an Apache-2.0
 * download.
 *
 * Shared by `pnpm vision:fetch-models` and the in-app downloader so the two
 * cannot disagree about what a group contains.
 */
export type ModelGroup = "faces" | "scene" | "objects" | "search";

export interface ModelGroupInfo {
  models: VisionModel[];
  /** One line, for a UI with room for one line. */
  licence: string;
  /** Does installing these require an explicit licence acceptance? */
  needsAck: boolean;
  /** What the pack is called, for a badge naming what is installed. */
  pack: string;
  label: string;
  /** What the group is for, in the user's terms. */
  purpose: string;
}

export const MODEL_GROUPS: Record<ModelGroup, ModelGroupInfo> = {
  faces: {
    models: FACE_MODELS,
    licence: "non-commercial research use only",
    needsAck: true,
    pack: FACE_MODEL_PACK,
    label: "Face recognition",
    purpose: "find and group faces",
  },
  scene: {
    models: SCENE_MODELS,
    licence: SCENE_LICENCE_SUMMARY,
    needsAck: false,
    pack: SCENE_MODEL_PACK,
    label: "Scene understanding",
    purpose: "describe photos so they can be searched",
  },
  objects: {
    models: OBJECT_MODELS,
    licence: SCENE_LICENCE_SUMMARY,
    needsAck: false,
    pack: OBJECT_MODEL_PACK,
    label: "Object detection",
    purpose: "label what is in a photo, so you can filter and count by it",
  },
  search: {
    models: SEARCH_MODELS,
    licence: SCENE_LICENCE_SUMMARY,
    needsAck: false,
    pack: SCENE_MODEL_PACK,
    label: "Search",
    purpose: "turn what you type into something comparable to your photos",
  },
};

export const MODEL_GROUP_NAMES = Object.keys(MODEL_GROUPS) as ModelGroup[];

export function groupModelStatus(group: ModelGroup): ModelInstallStatus {
  return statusOf(MODEL_GROUPS[group].models);
}

export function groupTotalBytes(group: ModelGroup): number {
  return MODEL_GROUPS[group].models.reduce((sum, model) => sum + model.sizeBytes, 0);
}
