/**
 * The geometry the SCRFD → ArcFace path needs and no npm package provides:
 * non-maximum suppression, and the 5-point similarity transform onto ArcFace's
 * canonical 112×112 template.
 *
 * Deliberately free of both ONNX and sharp — it is plain arithmetic over plain
 * arrays, which is what makes it the part of the engine that can be tested
 * without 278 MB of weights on disk.
 */

/** `[x1, y1, x2, y2]` — corner form, which is what the detector decodes to. */
export type Box = [number, number, number, number];

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  const inter = w * h;
  if (inter === 0) return 0;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * Greedy NMS. Returns the surviving indices, highest score first.
 *
 * Index-based rather than object-based so callers can carry keypoints (or
 * anything else) alongside the boxes without this function knowing about them.
 */
export function nms(boxes: readonly Box[], scores: readonly number[], iouThreshold: number): number[] {
  const order = boxes.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const keep: number[] = [];
  const suppressed = new Uint8Array(boxes.length);
  for (const i of order) {
    if (suppressed[i]) continue;
    keep.push(i);
    for (const j of order) {
      if (j === i || suppressed[j]) continue;
      if (iou(boxes[i], boxes[j]) > iouThreshold) suppressed[j] = 1;
    }
  }
  return keep;
}

/**
 * ArcFace's canonical five landmarks on a 112×112 crop: left eye, right eye,
 * nose tip, left mouth corner, right mouth corner. Every ArcFace-family
 * recogniser — glintr100 included — was trained on faces warped onto exactly
 * these coordinates, so this table is part of the model contract, not a
 * tunable.
 */
export const ARCFACE_TEMPLATE: ReadonlyArray<readonly [number, number]> = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

export const ARCFACE_CROP_SIZE = 112;

/**
 * A 2×3 affine matrix in row-major order:
 * `x' = a·x + b·y + tx`, `y' = c·x + d·y + ty`.
 */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

/**
 * Umeyama similarity transform (rotation + uniform scale + translation) mapping
 * `src` onto `dst`, least-squares over all point pairs.
 *
 * A *similarity* fit, not a full affine one: five landmarks would over-determine
 * an affine and let a bad nose keypoint shear the crop, which is precisely the
 * failure ArcFace alignment exists to avoid. Follows Umeyama 1991 §3, restricted
 * to 2-D where the SVD of a 2×2 covariance has a closed form.
 */
export function umeyamaSimilarity(
  src: ReadonlyArray<readonly [number, number]>,
  dst: ReadonlyArray<readonly [number, number]>,
): Affine {
  const n = src.length;
  if (n < 2 || n !== dst.length) {
    throw new Error(`umeyamaSimilarity needs ≥2 matched points, got ${src.length}/${dst.length}`);
  }

  let srcMeanX = 0, srcMeanY = 0, dstMeanX = 0, dstMeanY = 0;
  for (let i = 0; i < n; i++) {
    srcMeanX += src[i][0]; srcMeanY += src[i][1];
    dstMeanX += dst[i][0]; dstMeanY += dst[i][1];
  }
  srcMeanX /= n; srcMeanY /= n; dstMeanX /= n; dstMeanY /= n;

  // Covariance of the centred point sets, and the source variance that fixes
  // the scale factor.
  let c00 = 0, c01 = 0, c10 = 0, c11 = 0, srcVar = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - srcMeanX;
    const sy = src[i][1] - srcMeanY;
    const dx = dst[i][0] - dstMeanX;
    const dy = dst[i][1] - dstMeanY;
    c00 += dx * sx; c01 += dx * sy;
    c10 += dy * sx; c11 += dy * sy;
    srcVar += sx * sx + sy * sy;
  }
  c00 /= n; c01 /= n; c10 /= n; c11 /= n; srcVar /= n;

  // Maximising ⟨Σ, R(θ)⟩ = (c00+c11)·cosθ + (c10−c01)·sinθ over rotations has
  // this closed form in 2-D, which is what Umeyama's `U·S·Vᵀ` reduces to for a
  // 2×2 matrix. Restricted to *proper* rotations on purpose: the reflection
  // Umeyama's `S` matrix guards against would mirror the face, and a mirrored
  // face is a different face to ArcFace.
  const theta = Math.atan2(c10 - c01, c00 + c11);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  // Scale = trace(D·S) / σ²_src, which for the 2-D closed form is the projection
  // of the covariance onto the rotation.
  const scale = srcVar > 0 ? ((c00 + c11) * cos + (c10 - c01) * sin) / srcVar : 1;

  const a = scale * cos;
  const b = -scale * sin;
  const c = scale * sin;
  const d = scale * cos;
  return {
    a,
    b,
    c,
    d,
    tx: dstMeanX - (a * srcMeanX + b * srcMeanY),
    ty: dstMeanY - (c * srcMeanX + d * srcMeanY),
  };
}

/** Inverse of a 2×3 affine; throws if it is singular (a degenerate keypoint set). */
export function invertAffine(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) throw new Error("affine transform is singular");
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, tx: -(a * m.tx + b * m.ty), ty: -(c * m.tx + d * m.ty) };
}

export function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [m.a * x + m.b * y + m.tx, m.c * x + m.d * y + m.ty];
}
