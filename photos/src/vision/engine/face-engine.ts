/**
 * The face engine: image bytes → boxes, landmarks, and 512-d identity vectors.
 *
 * ⚠ **This module and everything it imports must never be reachable from
 * `app/`.** It is the only place `onnxruntime-node` is loaded, and open-next's
 * dependency tracer walks the route graph — one static import from a route and
 * 270 MB of ORT lands in the cloud `static` Lambda bundle. It is reached only
 * from the worker entry, which the scan controller starts by absolute path, and
 * `__tests__/vision-bundle-isolation.test.ts` fails if that ever stops being
 * true.
 *
 * It also takes decoded bytes rather than reaching for storage itself, which is
 * what would make it extractable as a standalone package later (plan §9).
 */

import type { InferenceSession, Tensor } from "onnxruntime-node";
import { alignmentTransform, toNchwFloat, warpToArcFaceCrop, type RgbImage } from "./align";
import { ARCFACE_CROP_SIZE } from "./geometry";
import {
  decodeScrfd,
  groupScrfdOutputs,
  letterboxScale,
  SCRFD_INPUT_SIZE,
  SCRFD_NMS_IOU,
  SCRFD_SCORE_THRESHOLD,
} from "./scrfd";

/** SCRFD normalisation, from the reference implementation. */
const SCRFD_MEAN = 127.5;
const SCRFD_STD = 128.0;
/** ArcFace normalisation: `(px − 127.5) / 127.5` → [−1, 1]. */
const ARCFACE_MEAN = 127.5;
const ARCFACE_STD = 127.5;

export interface EngineFace {
  /** `[x, y, width, height]` in the source image's pixel space. */
  bbox: [number, number, number, number];
  score: number;
  kps: Array<[number, number]>;
  /** L2-normalized 512-d identity vector. */
  embedding: Float32Array;
}

export interface EngineResult {
  /** Dimensions of the image as analysed — i.e. after EXIF rotation. */
  width: number;
  height: number;
  faces: EngineFace[];
}

export interface FaceEngineOptions {
  detectorPath: string;
  embedderPath: string;
  scoreThreshold?: number;
  nmsIou?: number;
}

/**
 * Holds the two ONNX sessions. Creating them is the expensive part (glintr100 is
 * 261 MB), so a scan builds one engine and reuses it for the whole pass.
 */
export class FaceEngine {
  private constructor(
    private readonly detector: InferenceSession,
    private readonly embedder: InferenceSession,
    private readonly ort: typeof import("onnxruntime-node"),
    private readonly sharp: typeof import("sharp").default,
    private readonly scoreThreshold: number,
    private readonly nmsIou: number,
  ) {}

  static async create(options: FaceEngineOptions): Promise<FaceEngine> {
    // Both specifiers are static strings here on purpose — this module is
    // already off the traced graph, so there is nothing to hide from the
    // bundler, and a computed specifier would only make the dependency
    // invisible to the type checker too.
    const ort = await import("onnxruntime-node");
    const sharpMod = await import("sharp");
    const sharp = (sharpMod.default ?? sharpMod) as unknown as typeof import("sharp").default;

    const [detector, embedder] = await Promise.all([
      ort.InferenceSession.create(options.detectorPath),
      ort.InferenceSession.create(options.embedderPath),
    ]);

    return new FaceEngine(
      detector,
      embedder,
      ort,
      sharp,
      options.scoreThreshold ?? SCRFD_SCORE_THRESHOLD,
      options.nmsIou ?? SCRFD_NMS_IOU,
    );
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.detector.release(), this.embedder.release()]);
  }

  /**
   * Detect and embed every face in `bytes`.
   *
   * `.rotate()` with no argument applies the EXIF orientation, so every
   * coordinate this returns is in **display** space — the space
   * `photo-viewer.tsx` renders in. Skipping it yields boxes that are correct but
   * rotated on exactly the photos that carry an orientation tag, which is the
   * kind of bug that survives a demo.
   */
  async analyze(bytes: Uint8Array): Promise<EngineResult> {
    const { data, info } = await this.sharp(bytes)
      .rotate()
      .removeAlpha()
      .toColorspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });

    const image: RgbImage = {
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width: info.width,
      height: info.height,
    };
    if (info.channels !== 3) {
      throw new Error(`expected 3-channel RGB after removeAlpha, got ${info.channels}`);
    }

    const detections = await this.detect(image);
    const faces: EngineFace[] = [];
    for (const detection of detections) {
      // A detection whose landmarks are collinear (or identical) makes the
      // similarity fit singular. That is a degenerate detection, not a fatal
      // error — drop the face and keep the photo.
      let embedding: Float32Array;
      try {
        embedding = await this.embed(image, detection.kps);
      } catch {
        continue;
      }
      const [x1, y1, x2, y2] = detection.box;
      faces.push({
        bbox: [x1, y1, x2 - x1, y2 - y1],
        score: detection.score,
        kps: detection.kps,
        embedding,
      });
    }

    return { width: info.width, height: info.height, faces };
  }

  /** SCRFD over a letterboxed 640² copy, with boxes mapped back to source pixels. */
  private async detect(image: RgbImage) {
    const scale = letterboxScale(image.width, image.height, SCRFD_INPUT_SIZE);
    const scaledW = Math.max(1, Math.round(image.width * scale));
    const scaledH = Math.max(1, Math.round(image.height * scale));

    // Pad at the top-left (`position: "left top"` with `extend` semantics), not
    // centred: the reference pastes the resized image at (0, 0), so a centred
    // pad would shift every detection by half the padding.
    const letterboxed = await this.sharp(Buffer.from(image.data), {
      raw: { width: image.width, height: image.height, channels: 3 },
    })
      .resize(scaledW, scaledH, { fit: "fill" })
      .extend({
        top: 0,
        left: 0,
        bottom: SCRFD_INPUT_SIZE - scaledH,
        right: SCRFD_INPUT_SIZE - scaledW,
        background: { r: 0, g: 0, b: 0 },
      })
      .raw()
      .toBuffer();

    const input = toNchwFloat(
      { data: new Uint8Array(letterboxed), width: SCRFD_INPUT_SIZE, height: SCRFD_INPUT_SIZE },
      SCRFD_MEAN,
      SCRFD_STD,
    );

    const feeds: Record<string, Tensor> = {
      [this.detector.inputNames[0]]: new this.ort.Tensor("float32", input, [
        1,
        3,
        SCRFD_INPUT_SIZE,
        SCRFD_INPUT_SIZE,
      ]),
    };
    const outputs = await this.detector.run(feeds);
    const heads = groupScrfdOutputs(this.detector.outputNames.map((name) => outputs[name]));

    const decoded = decodeScrfd(heads, {
      inputSize: SCRFD_INPUT_SIZE,
      scoreThreshold: this.scoreThreshold,
      nmsIou: this.nmsIou,
    });

    return decoded.map((d) => ({
      score: d.score,
      box: [d.box[0] / scale, d.box[1] / scale, d.box[2] / scale, d.box[3] / scale] as [
        number,
        number,
        number,
        number,
      ],
      kps: d.kps.map(([x, y]) => [x / scale, y / scale] as [number, number]),
    }));
  }

  /** Align to the ArcFace template and run glintr100, returning a unit vector. */
  private async embed(image: RgbImage, kps: ReadonlyArray<readonly [number, number]>) {
    const crop = warpToArcFaceCrop(image, alignmentTransform(kps), ARCFACE_CROP_SIZE);
    const input = toNchwFloat(crop, ARCFACE_MEAN, ARCFACE_STD);
    const feeds: Record<string, Tensor> = {
      [this.embedder.inputNames[0]]: new this.ort.Tensor("float32", input, [
        1,
        3,
        ARCFACE_CROP_SIZE,
        ARCFACE_CROP_SIZE,
      ]),
    };
    const outputs = await this.embedder.run(feeds);
    const raw = outputs[this.embedder.outputNames[0]].data as Float32Array;
    return l2Normalize(raw);
  }
}

/**
 * Unit-length in place-ish. Cosine similarity between normalized vectors is
 * just a dot product, which is what makes cluster assignment cheap — so every
 * embedding is normalized once, here, and never again.
 */
export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}
