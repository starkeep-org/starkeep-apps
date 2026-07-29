/**
 * The shapes Photos' on-device vision state is written in.
 *
 * These are file formats, not wire types: every one of them is JSON on the
 * user's disk under `app-local/photos/vision/`, and nothing here ever reaches
 * the sync plane.
 */

/** The one vision task implemented today. See `tasks.ts` for the registry. */
export type VisionTaskId = "faces";

/**
 * Every task id that has ever had a store, enabled or not.
 *
 * Deliberately not derived from the enabled config or from the task registry:
 * `reapOrphanSidecars` has to sweep **disabled** tasks too. Turning scene off,
 * deleting photos, and turning it back on must not resurrect sidecars for
 * records that are gone — they would be counted, and worse, folded over by the
 * end-of-pass reductions as though they were live.
 *
 * The registry in `engine/tasks.ts` cannot serve this: it only lists tasks whose
 * engine is loadable, and it lives behind the `app/` isolation boundary.
 */
export const VISION_TASK_IDS: readonly VisionTaskId[] = ["faces"];

/**
 * What every sidecar carries, whatever task wrote it.
 *
 * `v` and `model` are the two halves of the staleness check that drives
 * reprocessing, and they are per-task: bumping the scene format must not
 * invalidate face results. Dimensions are here rather than on the face payload
 * because they describe the *analysis*, not the faces — anything storing
 * display-space coordinates needs them, and anything that does not is a few
 * bytes worse off.
 */
export interface SidecarBase {
  /** Sidecar format version. A mismatch means "reprocess". */
  v: number;
  /** Which model (or model pair) produced this. A mismatch also means "reprocess". */
  model: string;
  /** ISO-8601. */
  processedAt: string;
  /** Display-orientation dimensions any stored coordinates are relative to. */
  w: number;
  h: number;
}

/**
 * A face as the engine found it, in **display** orientation.
 *
 * The worker rotates by EXIF before inference, so `bbox` and `kps` are in the
 * same coordinate space the viewer renders in — the alternative (storage
 * orientation) yields boxes that are correct-but-rotated on exactly the subset
 * of photos that carry an orientation tag.
 */
export interface DetectedFace {
  /** `[x, y, width, height]` in display pixels. */
  bbox: [number, number, number, number];
  /** Detector confidence, 0–1. */
  score: number;
  /** Five landmarks — eyes, nose, mouth corners — as `[x, y]` display pixels. */
  kps: Array<[number, number]>;
  /** L2-normalized 512-d identity vector, base64 of little-endian float32. */
  embedding: string;
  /** The cluster this face was assigned to, or null before assignment. */
  personId: string | null;
}

/** `faces/<recordId>.json`. */
export interface FaceSidecar extends SidecarBase {
  faces: DetectedFace[];
}

export const FACE_SIDECAR_VERSION = 1;

/** `people.json`. */
export interface Person {
  id: string;
  /** Empty until a human names the cluster. */
  name: string;
  createdAt: string;
  /**
   * Running mean of the cluster's face embeddings, L2-normalized, base64
   * float32. Kept here rather than recomputed from sidecars so assignment is
   * O(n·k) — the whole reason clustering is incremental (plan §4).
   */
  centroid: string;
  /** How many faces the centroid averages. Needed to update it in place. */
  faceCount: number;
}

export interface PeopleFile {
  people: Person[];
}

/** `scan-state.json`. */
export interface ScanState {
  /** Whether a pass is running right now, as of the last write. */
  running: boolean;
  /** Originals the scan set resolved to on the current/last pass. */
  eligible: number;
  /** Images that already had a current sidecar and were skipped. */
  skipped: number;
  /** Images the engine actually ran on, per task. */
  processed: Partial<Record<VisionTaskId, number>>;
  /** Images the engine threw on. Counted, not retried within a pass. */
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
  /** Set when the pass ended abnormally; null on a clean finish. */
  error: string | null;
}

export function emptyScanState(): ScanState {
  return {
    running: false,
    eligible: 0,
    skipped: 0,
    processed: {},
    failed: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

/** `config.json`. */
export interface VisionConfig {
  faces: {
    enabled: boolean;
    /** Cosine similarity above which a face joins an existing cluster. */
    threshold: number;
    /** Publish `photos/faces` and `photos/face-count` to the shared plane. */
    publishLabels: boolean;
  };
}

/**
 * Off by default, and `publishLabels` doubly so: publishing makes the names
 * queryable by any app holding an image read grant, which is a real disclosure
 * (see `starkeep-core/multi-value-labels.md`, "Privacy note").
 *
 * `objects` and `scene` are deliberately absent — their tasks are not built, and
 * a toggle for something that does nothing is worse than no toggle (plan §7).
 */
export function defaultVisionConfig(): VisionConfig {
  return { faces: { enabled: false, threshold: 0.45, publishLabels: false } };
}
