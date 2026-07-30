/**
 * The object engine: image bytes → labelled boxes in display pixels.
 *
 * The whole decode, and it is short — which is the point §9 made. A DETR-family
 * model emits **set predictions**: 300 queries, each a class distribution and one
 * box. There is no anchor grid to walk, no stride decoding, and **no NMS**, which
 * together are most of what `scrfd.ts` is. Nothing downstream either: no
 * alignment, no embedding, no clustering, no naming.
 *
 * ⚠ **Never import this from `app/`.** It loads `onnxruntime-node`. See
 * `face-engine.ts` for the argument and `vision-bundle-isolation.test.ts` for the
 * guard.
 *
 * **Where this diverges from plan §9, and why.** §9 was written against
 * DETR-ResNet50 and describes "softmax over logits, drop the no-object class" plus
 * "ImageNet normalization". D-FINE — like the RT-DETRv2 this replaced — does
 * neither, and both mistakes are the quiet kind:
 *
 *   - Scores are a **per-class sigmoid**, trained with a focal loss. A softmax would
 *     force the classes to sum to one, making a confident single-object photo look
 *     uncertain and a busy one look confident — a systematic distortion of exactly
 *     the number the threshold reads.
 *   - Preprocessing is a **÷255 rescale only** (`do_normalize: false`), even though
 *     the config file carries ImageNet mean/std it does not use. Subtracting them
 *     shifts every pixel off the distribution the model was trained on.
 *
 * Both are asserted against the real graph in `vision-objects.test.ts`, because
 * neither would throw.
 *
 * **The one thing §9's "drop the no-object class" still applies to.** Objects365 is
 * 1-indexed upstream, so slot 0 of the 366 logits is an unused `None` placeholder
 * rather than a category. It is not a no-object *score* in the DETR sense — nothing
 * needs subtracting — but it must never be argmaxed into a detection, hence
 * `BACKGROUND_CLASS`.
 */

import type { InferenceSession, Tensor } from "onnxruntime-node";
import { OBJECT_CLASS_COUNT, OBJECT_INPUT_SIZE } from "../models";
import { BACKGROUND_CLASS } from "../object-classes";
import { DEFAULT_OBJECT_THRESHOLD } from "../types";

export interface EngineObject {
  /** Index into `OBJECT_CLASSES`. The index, not the name, is what the model said. */
  classIndex: number;
  /** Sigmoid confidence, 0–1. */
  score: number;
  /** `[x, y, width, height]` in display pixels. */
  bbox: [number, number, number, number];
}

export interface ObjectResult {
  /** Dimensions of the image as analysed — i.e. after EXIF rotation. */
  width: number;
  height: number;
  objects: EngineObject[];
}

export class ObjectEngine {
  private constructor(
    private readonly detector: InferenceSession,
    private readonly ort: typeof import("onnxruntime-node"),
    private readonly sharp: typeof import("sharp"),
    private readonly scoreThreshold: number,
  ) {}

  static async create(options: {
    detectorPath: string;
    scoreThreshold?: number;
  }): Promise<ObjectEngine> {
    const ort = await import("onnxruntime-node");
    const sharpMod = await import("sharp");
    const sharp = (sharpMod.default ?? sharpMod) as unknown as typeof import("sharp");
    const detector = await ort.InferenceSession.create(options.detectorPath);
    return new ObjectEngine(
      detector,
      ort,
      sharp,
      options.scoreThreshold ?? DEFAULT_OBJECT_THRESHOLD,
    );
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.detector.release()]);
  }

  /**
   * Detect every object above the threshold.
   *
   * `.rotate()` applies EXIF orientation first, so every box returned is in
   * **display** space — the space `photo-viewer.tsx` renders in. This is the
   * orientation-correctness work the face path already solved, inherited for free
   * exactly as §9 said it would be; the alternative is boxes that are
   * correct-but-rotated on precisely the photos carrying an orientation tag.
   */
  async detect(bytes: Uint8Array): Promise<ObjectResult> {
    const { data, info } = await this.sharp(bytes)
      .rotate()
      .removeAlpha()
      .toColorspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.channels !== 3) {
      throw new Error(`expected 3-channel RGB after removeAlpha, got ${info.channels}`);
    }

    // Squashed to a square, not letterboxed: the export sets `do_pad: false` and a
    // flat 640×640 size. That gives two independent scale factors on the way back
    // out, which is why the un-projection below multiplies width and height
    // separately rather than dividing by one letterbox scale.
    const resized = await this.sharp(data, {
      raw: { width: info.width, height: info.height, channels: 3 },
    })
      .resize(OBJECT_INPUT_SIZE, OBJECT_INPUT_SIZE, { fit: "fill", kernel: "cubic" })
      .raw()
      .toBuffer();

    const input = toNchwRescaled(new Uint8Array(resized), OBJECT_INPUT_SIZE);
    const feeds: Record<string, Tensor> = {
      pixel_values: new this.ort.Tensor("float32", input, [
        1,
        3,
        OBJECT_INPUT_SIZE,
        OBJECT_INPUT_SIZE,
      ]),
    };
    const outputs = await this.detector.run(feeds);

    const logits = outputs.logits ?? outputs[this.detector.outputNames[0]];
    const boxes = outputs.pred_boxes ?? outputs[this.detector.outputNames[1]];

    return {
      width: info.width,
      height: info.height,
      objects: decodeDetections(
        logits.data as Float32Array,
        boxes.data as Float32Array,
        info.width,
        info.height,
        this.scoreThreshold,
      ),
    };
  }
}

/**
 * `logits` + `pred_boxes` → detections in pixel space.
 *
 * Pure, and exported so it can be tested without a 307 MB graph — the arithmetic
 * here is where a coordinate-convention mistake would live, and such a mistake
 * produces boxes that are plausible and wrong rather than an error.
 *
 * One detection per query at most, taking its **best** class. A query is one
 * predicted object, so emitting it once per class over threshold would report the
 * same dog as a dog and a cat and inflate every count.
 */
export function decodeDetections(
  logits: Float32Array,
  boxes: Float32Array,
  displayWidth: number,
  displayHeight: number,
  scoreThreshold: number,
): EngineObject[] {
  const queries = logits.length / OBJECT_CLASS_COUNT;
  if (!Number.isInteger(queries)) {
    throw new Error(`${logits.length} logits is not a multiple of ${OBJECT_CLASS_COUNT} classes`);
  }
  if (boxes.length !== queries * 4) {
    throw new Error(`${boxes.length} box values for ${queries} queries`);
  }

  const out: EngineObject[] = [];
  for (let query = 0; query < queries; query++) {
    let bestIndex = -1;
    let bestScore = 0;
    // From 1: slot 0 is Objects365's unused `None` placeholder, not a category.
    // Starting at 0 would let a query be reported as a detection named "None".
    for (let cls = BACKGROUND_CLASS + 1; cls < OBJECT_CLASS_COUNT; cls++) {
      // Sigmoid per class — see the module comment. Independent probabilities, so
      // they do not and should not sum to one.
      const score = 1 / (1 + Math.exp(-logits[query * OBJECT_CLASS_COUNT + cls]));
      if (score > bestScore) {
        bestScore = score;
        bestIndex = cls;
      }
    }
    if (bestIndex < 0 || bestScore < scoreThreshold) continue;

    // Normalized `cxcywh` → display-pixel `xywh`. Centre-based, so the corner is
    // half a width left of the centre; reading these as corners would place every
    // box down and right by half its size.
    const cx = boxes[query * 4];
    const cy = boxes[query * 4 + 1];
    const w = boxes[query * 4 + 2];
    const h = boxes[query * 4 + 3];

    const pixelW = w * displayWidth;
    const pixelH = h * displayHeight;
    // Clamped to the frame: a box may legitimately extend past the edge for a
    // partly-visible object, and a negative origin breaks every consumer that
    // treats the box as a crop rectangle.
    const x = Math.max(0, cx * displayWidth - pixelW / 2);
    const y = Math.max(0, cy * displayHeight - pixelH / 2);

    out.push({
      classIndex: bestIndex,
      score: bestScore,
      bbox: [
        Math.round(x),
        Math.round(y),
        Math.round(Math.min(pixelW, displayWidth - x)),
        Math.round(Math.min(pixelH, displayHeight - y)),
      ],
    });
  }

  // Highest confidence first, so a UI that shows only the top few shows the ones
  // worth showing.
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Interleaved RGB bytes → planar NCHW float32 in [0, 1].
 *
 * A ÷255 rescale and nothing else, per `do_normalize: false`. Deliberately its own
 * function rather than a parameterized share with `siglip.ts`'s
 * `toNchwNormalized`: the two differ precisely in the normalization that must not
 * be confused between them, and a shared helper with mean/std arguments is how
 * that confusion gets introduced later.
 */
export function toNchwRescaled(rgb: Uint8Array, size: number): Float32Array {
  const pixels = size * size;
  if (rgb.length !== pixels * 3) {
    throw new Error(`expected ${pixels * 3} bytes for ${size}², got ${rgb.length}`);
  }
  const out = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    out[i] = rgb[i * 3] / 255;
    out[pixels + i] = rgb[i * 3 + 1] / 255;
    out[pixels * 2 + i] = rgb[i * 3 + 2] / 255;
  }
  return out;
}
