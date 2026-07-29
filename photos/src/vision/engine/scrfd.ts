/**
 * SCRFD post-processing: nine output tensors → boxes, scores, and five
 * landmarks per face.
 *
 * There is no npm package that does this (the reason plan §3 calls the engine
 * the risky step), so it is written out here against the reference
 * implementation's shape — `insightface/detection/scrfd`, mirrored in
 * `insightface/python-package/insightface/model_zoo/scrfd.py`.
 *
 * The three facts the whole file rests on:
 *
 * 1. **Three strides, nine tensors.** `scrfd_10g_bnkps` emits, in output order,
 *    scores for strides 8/16/32, then bbox deltas for 8/16/32, then keypoint
 *    deltas for 8/16/32. `fmc = 3` in the reference; the outputs are addressed
 *    as `outs[i]`, `outs[i + 3]`, `outs[i + 6]`.
 * 2. **Two anchors per cell**, laid out interleaved: cell (y, x) owns rows
 *    `2·(y·W + x)` and `2·(y·W + x) + 1`, both centred on `(x·stride, y·stride)`.
 *    Anchor-free, so both anchors share a centre and differ only in what they
 *    learned to predict.
 * 3. **Distance regression.** A bbox row is `[left, top, right, bottom]`
 *    *distances from the anchor centre*, in stride units. Keypoints are
 *    `[dx, dy] × 5`, also in stride units, signed from the centre.
 *
 * Nothing here touches ONNX types — it takes flat `Float32Array`s — so the whole
 * decode is testable against hand-built tensors.
 */

import { nms, type Box } from "./geometry";

/** Input the detector is fed. 640² is what antelopev2 is tuned for. */
export const SCRFD_INPUT_SIZE = 640;
export const SCRFD_STRIDES = [8, 16, 32] as const;
export const SCRFD_ANCHORS_PER_CELL = 2;

/** Reference defaults: 0.5 keeps false positives out, 0.4 is the standard IoU. */
export const SCRFD_SCORE_THRESHOLD = 0.5;
export const SCRFD_NMS_IOU = 0.4;

/** One SCRFD head's three tensors, already flattened. */
export interface StrideOutputs {
  stride: number;
  /** `N` scores, one per anchor row. */
  scores: Float32Array;
  /** `N × 4` distances, row-major. */
  bboxes: Float32Array;
  /** `N × 10` keypoint offsets, row-major. */
  kps: Float32Array;
}

export interface DecodedDetection {
  /** `[x1, y1, x2, y2]` in *network input* pixels (before un-letterboxing). */
  box: Box;
  score: number;
  /** Five `[x, y]` landmarks, also in network input pixels. */
  kps: Array<[number, number]>;
}

/**
 * Anchor centres for one stride at a given input size, in input pixels.
 *
 * Cached because a scan calls this once per stride per image and the answer only
 * depends on `(inputSize, stride)` — three small arrays for the life of the
 * process, versus rebuilding 12,800 pairs per photo.
 */
const centreCache = new Map<string, Float32Array>();

export function anchorCentres(inputSize: number, stride: number): Float32Array {
  const key = `${inputSize}:${stride}`;
  const cached = centreCache.get(key);
  if (cached) return cached;

  const gridW = Math.ceil(inputSize / stride);
  const gridH = Math.ceil(inputSize / stride);
  const out = new Float32Array(gridW * gridH * SCRFD_ANCHORS_PER_CELL * 2);
  let i = 0;
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      for (let a = 0; a < SCRFD_ANCHORS_PER_CELL; a++) {
        out[i++] = x * stride;
        out[i++] = y * stride;
      }
    }
  }
  centreCache.set(key, out);
  return out;
}

/**
 * Decode one stride's head into detections above `scoreThreshold`.
 *
 * Exported separately from {@link decodeScrfd} so a single head can be driven
 * from a hand-built fixture without constructing all nine tensors.
 */
export function decodeStride(
  out: StrideOutputs,
  inputSize: number,
  scoreThreshold: number,
): DecodedDetection[] {
  const centres = anchorCentres(inputSize, out.stride);
  const rows = out.scores.length;
  if (centres.length < rows * 2) {
    throw new Error(
      `stride ${out.stride}: ${rows} score rows exceed the ${centres.length / 2} anchors a ` +
        `${inputSize}² input has — wrong input size, or the outputs are in a different order`,
    );
  }

  const detections: DecodedDetection[] = [];
  for (let i = 0; i < rows; i++) {
    const score = out.scores[i];
    if (score < scoreThreshold) continue;

    const cx = centres[i * 2];
    const cy = centres[i * 2 + 1];
    const b = i * 4;
    // Distances are in stride units and point outward from the centre, so the
    // left/top pair is subtracted and the right/bottom pair added.
    const box: Box = [
      cx - out.bboxes[b] * out.stride,
      cy - out.bboxes[b + 1] * out.stride,
      cx + out.bboxes[b + 2] * out.stride,
      cy + out.bboxes[b + 3] * out.stride,
    ];

    const k = i * 10;
    const kps: Array<[number, number]> = [];
    for (let p = 0; p < 5; p++) {
      kps.push([cx + out.kps[k + p * 2] * out.stride, cy + out.kps[k + p * 2 + 1] * out.stride]);
    }

    detections.push({ box, score, kps });
  }
  return detections;
}

export interface ScrfdDecodeOptions {
  inputSize?: number;
  scoreThreshold?: number;
  nmsIou?: number;
}

/**
 * Decode all three heads and suppress overlaps. Results are highest-score first.
 */
export function decodeScrfd(
  heads: readonly StrideOutputs[],
  options: ScrfdDecodeOptions = {},
): DecodedDetection[] {
  const inputSize = options.inputSize ?? SCRFD_INPUT_SIZE;
  const scoreThreshold = options.scoreThreshold ?? SCRFD_SCORE_THRESHOLD;
  const nmsIou = options.nmsIou ?? SCRFD_NMS_IOU;

  const all: DecodedDetection[] = [];
  for (const head of heads) all.push(...decodeStride(head, inputSize, scoreThreshold));

  // NMS runs across strides, not per stride: the same face is routinely picked
  // up by two heads, and suppressing within a head alone leaves it duplicated.
  const keep = nms(all.map((d) => d.box), all.map((d) => d.score), nmsIou);
  return keep.map((i) => all[i]);
}

/**
 * The letterbox SCRFD expects: scale the longest side to `inputSize`, keep the
 * aspect ratio, and pad to a square **at the top-left**.
 *
 * Top-left rather than centred is not a preference — the reference
 * implementation pastes at (0, 0), so a centred pad would offset every box by
 * half the padding. Returns the scale so detections can be mapped back.
 */
export function letterboxScale(width: number, height: number, inputSize: number): number {
  return Math.min(inputSize / width, inputSize / height);
}

/**
 * Sort the detector's nine outputs into per-stride heads.
 *
 * By **shape**, not by position. The reference implementation indexes outputs
 * positionally (`outs[i]`, `outs[i+3]`, `outs[i+6]`), which is silently wrong if
 * a re-export ever reorders them — and the symptom would be plausible-looking
 * boxes in the wrong places rather than an error. The last dimension names the
 * kind (1 = score, 4 = bbox delta, 10 = keypoint delta) and the row count names
 * the stride, so both are read rather than assumed.
 *
 * Takes the tensors structurally rather than as ORT types, so it stays testable
 * without the runtime — and, more to the point, without the models.
 */
export function groupScrfdOutputs(
  tensors: ReadonlyArray<{ dims: readonly number[]; data: unknown }>,
): StrideOutputs[] {
  const byStride = new Map<number, Partial<StrideOutputs>>();

  for (const tensor of tensors) {
    // ORT renders these as [N, C]; some exports carry a leading batch axis.
    const dims =
      tensor.dims.length === 3 && tensor.dims[0] === 1 ? tensor.dims.slice(1) : tensor.dims;
    if (dims.length !== 2) {
      throw new Error(`unexpected SCRFD output rank: [${tensor.dims.join(", ")}]`);
    }
    const [rows, channels] = dims;

    const stride = strideForRowCount(rows);
    const head = byStride.get(stride) ?? { stride };
    const data = tensor.data as Float32Array;
    if (channels === 1) head.scores = data;
    else if (channels === 4) head.bboxes = data;
    else if (channels === 10) head.kps = data;
    else throw new Error(`unexpected SCRFD output width ${channels} (expected 1, 4, or 10)`);
    byStride.set(stride, head);
  }

  return SCRFD_STRIDES.map((stride) => {
    const head = byStride.get(stride);
    if (!head?.scores || !head.bboxes || !head.kps) {
      throw new Error(`SCRFD output for stride ${stride} is incomplete — is this a *_bnkps graph?`);
    }
    return head as StrideOutputs;
  });
}

function strideForRowCount(rows: number): number {
  for (const stride of SCRFD_STRIDES) {
    const grid = Math.ceil(SCRFD_INPUT_SIZE / stride);
    if (grid * grid * SCRFD_ANCHORS_PER_CELL === rows) return stride;
  }
  throw new Error(`no SCRFD stride produces ${rows} anchor rows at ${SCRFD_INPUT_SIZE}²`);
}
