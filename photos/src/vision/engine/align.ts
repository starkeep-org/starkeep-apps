/**
 * Warping a detected face onto ArcFace's canonical 112×112 crop.
 *
 * Done here rather than through sharp's `affine()` because the sampling is the
 * part that has to be right: glintr100 was trained on bilinearly-warped crops,
 * and a 112×112 crop is 12,544 samples — small enough that owning the loop costs
 * nothing and buys exact, testable control over the transform's conventions.
 *
 * Operates on raw interleaved RGB, so it has no image-codec dependency and can
 * be driven from a synthetic buffer in a test.
 */

import {
  applyAffine,
  ARCFACE_CROP_SIZE,
  ARCFACE_TEMPLATE,
  invertAffine,
  umeyamaSimilarity,
  type Affine,
} from "./geometry";

/** Interleaved 8-bit RGB, `width × height × 3`. */
export interface RgbImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * The similarity transform taking a face's five landmarks onto the ArcFace
 * template.
 */
export function alignmentTransform(kps: ReadonlyArray<readonly [number, number]>): Affine {
  if (kps.length !== ARCFACE_TEMPLATE.length) {
    throw new Error(`ArcFace alignment needs ${ARCFACE_TEMPLATE.length} landmarks, got ${kps.length}`);
  }
  return umeyamaSimilarity(kps, ARCFACE_TEMPLATE);
}

/**
 * Bilinear inverse warp: for each *destination* pixel, find where it came from
 * in the source and sample there.
 *
 * Forward-mapping source pixels would leave holes wherever the transform scales
 * up, which for a small face in a large photo is most of the crop.
 * Out-of-bounds reads clamp to the edge, so a face at the frame border produces
 * a smeared margin rather than a black one — black would look to the model like
 * an occlusion that is not there.
 */
export function warpToArcFaceCrop(
  image: RgbImage,
  transform: Affine,
  size: number = ARCFACE_CROP_SIZE,
): RgbImage {
  const inverse = invertAffine(transform);
  const out = new Uint8Array(size * size * 3);
  const { data, width, height } = image;

  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      // Pixel centres, hence the +0.5 out and −0.5 back: sampling at integer
      // corners biases the whole crop half a pixel up and left.
      const [fx, fy] = applyAffine(inverse, dx + 0.5, dy + 0.5);
      const sx = fx - 0.5;
      const sy = fy - 0.5;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const wx = sx - x0;
      const wy = sy - y0;

      const x0c = clamp(x0, 0, width - 1);
      const x1c = clamp(x0 + 1, 0, width - 1);
      const y0c = clamp(y0, 0, height - 1);
      const y1c = clamp(y0 + 1, 0, height - 1);

      const i00 = (y0c * width + x0c) * 3;
      const i01 = (y0c * width + x1c) * 3;
      const i10 = (y1c * width + x0c) * 3;
      const i11 = (y1c * width + x1c) * 3;
      const o = (dy * size + dx) * 3;

      for (let c = 0; c < 3; c++) {
        const top = data[i00 + c] * (1 - wx) + data[i01 + c] * wx;
        const bottom = data[i10 + c] * (1 - wx) + data[i11 + c] * wx;
        out[o + c] = Math.round(top * (1 - wy) + bottom * wy);
      }
    }
  }

  return { data: out, width: size, height: size };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Interleaved RGB → the NCHW float tensor an InsightFace graph expects:
 * planar, `(pixel − mean) / std`, batch of one.
 *
 * Both graphs use the same normalisation — mean 127.5, std 128 for SCRFD and
 * 127.5/127.5 for glintr100 — so the caller passes them rather than this
 * function guessing from the shape.
 */
export function toNchwFloat(image: RgbImage, mean: number, std: number): Float32Array {
  const { data, width, height } = image;
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    out[p] = (data[p * 3] - mean) / std;
    out[plane + p] = (data[p * 3 + 1] - mean) / std;
    out[2 * plane + p] = (data[p * 3 + 2] - mean) / std;
  }
  return out;
}
