/**
 * The scene engine: image bytes → one L2-normalized whole-image embedding.
 *
 * SigLIP 2 so400m/16-384's image tower, and much less code than the face path
 * because there is nothing to decode. A contrastive image tower emits one vector
 * for the whole frame: no anchor grids, no stride decoding, no NMS, no alignment,
 * no clustering. Preprocess, run, normalize.
 *
 * ⚠ **This module and everything it imports must never be reachable from
 * `app/`.** It loads `onnxruntime-node`. See `face-engine.ts` for the full
 * argument and `__tests__/vision-bundle-isolation.test.ts` for the guard.
 *
 * Like the face engine it takes decoded bytes rather than reaching for storage,
 * which is what keeps the engine extractable.
 */

import type { InferenceSession, Tensor } from "onnxruntime-node";
import { SCENE_INPUT_SIZE, SCENE_MEAN, SCENE_STD, SCENE_EMBEDDING_DIM } from "../models";
import { l2Normalize } from "./face-engine";

export interface SceneResult {
  /** Dimensions of the image as analysed — i.e. after EXIF rotation. */
  width: number;
  height: number;
  /** L2-normalized whole-image embedding. */
  embedding: Float32Array;
}

export class SceneEngine {
  private constructor(
    private readonly image: InferenceSession,
    private readonly ort: typeof import("onnxruntime-node"),
    private readonly sharp: typeof import("sharp"),
  ) {}

  static async create(options: { imagePath: string }): Promise<SceneEngine> {
    const ort = await import("onnxruntime-node");
    const sharpMod = await import("sharp");
    const sharp = (sharpMod.default ?? sharpMod) as unknown as typeof import("sharp");
    const image = await ort.InferenceSession.create(options.imagePath);
    return new SceneEngine(image, ort, sharp);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.image.release()]);
  }

  /**
   * Embed the whole image.
   *
   * `.rotate()` applies EXIF orientation before anything else. It matters even
   * with no coordinates to place: a sideways photo embeds as a sideways photo,
   * and "beach" ranks worse for it. The face path needs this for box correctness,
   * this path needs it for accuracy, and both get it from the same call.
   *
   * **`fit: "fill"` is not a shortcut.** SigLIP squashes to a square rather than
   * resizing the short side and centre-cropping the way CLIP does — see
   * `preprocessor_config.json`, which specifies a flat 384×384 with no crop.
   * Centre-cropping here would silently discard the edges of every non-square
   * photo, which is most of them, and produce embeddings that are self-consistent
   * and quietly wrong. Same trap as the normalization below.
   */
  async embed(bytes: Uint8Array): Promise<SceneResult> {
    // Two passes over the decoded image: one to learn the display dimensions,
    // one to produce the square input. `resize` cannot report the pre-resize
    // size, and the sidecar records what was actually analysed.
    const rotated = await this.sharp(bytes)
      .rotate()
      .removeAlpha()
      .toColorspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (rotated.info.channels !== 3) {
      throw new Error(`expected 3-channel RGB after removeAlpha, got ${rotated.info.channels}`);
    }

    const resized = await this.sharp(rotated.data, {
      raw: { width: rotated.info.width, height: rotated.info.height, channels: 3 },
    })
      // `kernel: "cubic"` matches the export's `resample: 2` (PIL BILINEAR is
      // sharp's `cubic`'s nearest honest analogue; the difference is well below
      // the noise floor of a 384² downsample, unlike the crop and normalization
      // decisions above and below).
      .resize(SCENE_INPUT_SIZE, SCENE_INPUT_SIZE, { fit: "fill", kernel: "cubic" })
      .raw()
      .toBuffer();

    const input = toNchwNormalized(new Uint8Array(resized), SCENE_INPUT_SIZE);
    const feeds: Record<string, Tensor> = {
      [this.image.inputNames[0]]: new this.ort.Tensor("float32", input, [
        1,
        3,
        SCENE_INPUT_SIZE,
        SCENE_INPUT_SIZE,
      ]),
    };
    const outputs = await this.image.run(feeds);

    // `pooler_output` when the export names it, else the first output. The
    // so400m export emits both a pooled vector and per-patch hidden states, and
    // taking the wrong one yields a 384×1152 matrix read as a vector — which
    // would not throw, it would just rank nonsense.
    const name = this.image.outputNames.includes("pooler_output")
      ? "pooler_output"
      : this.image.outputNames[0];
    const raw = outputs[name].data as Float32Array;
    if (raw.length !== SCENE_EMBEDDING_DIM) {
      throw new Error(
        `scene embedding is ${raw.length}-d, expected ${SCENE_EMBEDDING_DIM} ` +
          `(output "${name}" of ${this.image.outputNames.join(", ")})`,
      );
    }

    return {
      width: rotated.info.width,
      height: rotated.info.height,
      embedding: l2Normalize(raw),
    };
  }
}

/**
 * Interleaved RGB bytes → planar NCHW float32, normalized to [−1, 1].
 *
 * `(px − 127.5) / 127.5`, i.e. mean/std 0.5 on the 0–1 scale, from the export's
 * `preprocessor_config.json`. **Not ImageNet statistics** — SigLIP does not use
 * them, and substituting them is the other silent-accuracy-loss trap alongside
 * the centre-crop one. Kept here rather than reusing `align.ts`'s `toNchwFloat`
 * because that one belongs to the face path's crop pipeline and shares nothing
 * with this but arithmetic.
 */
export function toNchwNormalized(rgb: Uint8Array, size: number): Float32Array {
  const pixels = size * size;
  if (rgb.length !== pixels * 3) {
    throw new Error(`expected ${pixels * 3} bytes for ${size}², got ${rgb.length}`);
  }
  const out = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    out[i] = (rgb[i * 3] - SCENE_MEAN) / SCENE_STD;
    out[pixels + i] = (rgb[i * 3 + 1] - SCENE_MEAN) / SCENE_STD;
    out[pixels * 2 + i] = (rgb[i * 3 + 2] - SCENE_MEAN) / SCENE_STD;
  }
  return out;
}
