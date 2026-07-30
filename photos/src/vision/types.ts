/**
 * The shapes Photos' on-device vision state is written in.
 *
 * These are file formats, not wire types: every one of them is JSON on the
 * user's disk under `app-local/photos/vision/`, and nothing here ever reaches
 * the sync plane.
 */

/** The vision tasks implemented today. See `engine/tasks.ts` for the registry. */
export type VisionTaskId = "faces" | "scene" | "objects";

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
export const VISION_TASK_IDS: readonly VisionTaskId[] = ["faces", "scene", "objects"];

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

/**
 * `scene/<recordId>.json` — the whole-image embedding, and nothing else yet.
 *
 * **No tags here, deliberately.** Derived tags are a scoring of this embedding
 * against a vocabulary's text embeddings, and §7's whole point is that changing
 * the vocabulary re-scores rather than re-infers: one dot product per
 * (image, tag) over vectors already on disk, no model load and no image decode.
 * Storing tags now would mean either loading the text tower in the scan worker —
 * which is search's, not the scan's — or caching a scoring whose inputs change
 * without the sidecar going stale. Tags land in step 4 with the vocabulary that
 * defines them.
 *
 * No bounding boxes either, so `w`/`h` describe the analysed image rather than
 * anchoring coordinates. They are kept because the staleness check and the
 * "what did we actually look at" question are the same for every task.
 */
export interface SceneSidecar extends SidecarBase {
  /**
   * L2-normalized whole-image embedding, base64 of little-endian float32.
   *
   * Normalized once by the engine so every cosine downstream — search ranking,
   * tag scoring — is a plain dot product. Same encoding as a face embedding and
   * **not comparable to one**: that vector encodes identity in ArcFace's space
   * and this one encodes appearance in a language-aligned space. Cosine between
   * them is noise, and since both are base64 float32 it would fail silently,
   * which is why they live under different keys in different sidecars (§4).
   */
  embedding: string;
}

export const SCENE_SIDECAR_VERSION = 1;

/**
 * One detected object, in **display** orientation.
 *
 * Same coordinate convention as `DetectedFace`, and for the same reason: the
 * worker rotates by EXIF before inference, so `bbox` is in the space the viewer
 * renders in.
 */
export interface DetectedObject {
  /**
   * Index into `COCO_CLASSES`.
   *
   * The index rather than the name, because the index is what the model actually
   * emitted and the name is a lookup. Storing names would bake a spelling into
   * every sidecar on disk and make renaming a class a migration.
   */
  cls: number;
  /** Detector confidence, 0–1 — a per-class sigmoid, not a softmax share. */
  score: number;
  /** `[x, y, width, height]` in display pixels. */
  bbox: [number, number, number, number];
}

/** `objects/<recordId>.json`. */
export interface ObjectSidecar extends SidecarBase {
  objects: DetectedObject[];
}

export const OBJECT_SIDECAR_VERSION = 1;

/**
 * Default sigmoid score below which a query is not a detection.
 *
 * 0.5 is far too high for a focal-loss detector — its calibrated scores sit low —
 * and much lower invents furniture in every photo. 0.35 is the usual starting point
 * for RT-DETR.
 *
 * Here rather than in `models.ts` because it is a *config default*, like the face
 * threshold above it, and because `models.ts` reaches `paths.ts` which reaches this
 * module — importing a value back the other way would close that circle.
 */
export const DEFAULT_OBJECT_THRESHOLD = 0.35;

/**
 * **Empty on purpose — tag suggestions are parked.**
 *
 * A hand-authored seed list of ~70 phrases used to live here, and measuring it
 * against a real library is what retired it: only 21 phrases ever fired, one
 * ("a candid photo of people") fired on *every* photo and so carried no
 * information at all, and one ("a hike") dominated as a generic outdoor-people
 * attractor. That is §11's "too large makes every photo score something", observed
 * rather than predicted.
 *
 * The mechanism it fed is intact — the vocabulary is still configurable and
 * `/api/vision/vocabulary` still embeds whatever it is given — so unparking this is
 * a matter of putting a *better-sourced* list in, not of rebuilding anything. What
 * the retired list got wrong was its source, not its shape: candidates authored
 * upfront by a developer cannot know what is in someone's library.
 *
 * Better sources, when this is picked up again:
 *
 *   - the user's own captions and titles, which are both genuinely derived from the
 *     library and better phrased than anything invented for them;
 *   - empirical pruning — drop candidates that fire on everything or nothing, which
 *     is exactly the measurement above, as an action rather than an investigation;
 *   - a captioning model (BLIP or a small VLM) if tags should be *generated* from
 *     photos. SigLIP cannot do this: it only scores an image against strings supplied
 *     to it, which is why a candidate list has to exist at all.
 *
 * Note that search does not depend on any of this — a free-form query is embedded at
 * query time and never consults the vocabulary. Tags buy browsability and cross-app
 * labels, not retrieval.
 */
export const DEFAULT_TAG_VOCABULARY: readonly string[] = [];

/**
 * Threshold for suggesting a vocabulary entry.
 *
 * Low in absolute terms because SigLIP cosines are low in absolute terms — the
 * cross-modal band measured on real photos runs roughly 0.00–0.12 (see
 * `vision-model-choice.md`). This is a *suggestion* cutoff, not a decision: §7
 * publishes only what a human confirms.
 */
export const DEFAULT_TAG_THRESHOLD = 0.06;

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
  scene: {
    /**
     * Embed every original with the image tower, which is what search ranks
     * against. No sub-toggle for search: an embedding with nothing querying it is
     * inert, and a search over no embeddings is an empty result page — the two
     * are one feature.
     */
    enabled: boolean;
  };
  tags: {
    /**
     * The candidate list zero-shot tagging scores against.
     *
     * CLIP cannot emit tags on its own — it only scores an image against candidate
     * strings supplied to it — so "the vocabulary" *is* the feature. Editing it is a
     * different operation from editing the tags on one photo (§7), and it is cheap:
     * with the image embedding already in the sidecar, re-scoring is one dot product
     * per (image, tag), no model load and no image decode.
     */
    vocabulary: string[];
    /**
     * Cosine above which a vocabulary entry is *suggested*.
     *
     * §7 is explicit that raw CLIP cosine is uncalibrated and
     * vocabulary-dependent, so this cannot be a calibrated probability and derived
     * tags stay **suggestions** rather than facts. §11 lists the seed list's size and
     * content as settle-by-trying, and this knob with it.
     */
    threshold: number;
  };
  objects: {
    enabled: boolean;
    /**
     * Sigmoid score below which a detection is discarded.
     *
     * A knob rather than a constant because a focal-loss detector's scores are
     * uncalibrated in the same way §5.1's cosines are: the useful cutoff depends on
     * whether the user would rather miss a chair or invent one, and only real
     * photos settle it.
     */
    threshold: number;
  };
}

/**
 * Off by default, and `publishLabels` doubly so: publishing makes the names
 * queryable by any app holding an image read grant, which is a real disclosure
 * (see `starkeep-core/multi-value-labels.md`, "Privacy note").
 *
 * `scene` is off by default too, and for a blunter reason than privacy: turning
 * it on commits to a multi-hour first pass and a 1.7 GB download. That is a
 * decision to opt into, not to discover.
 *
 * Every task is off by default: each commits to a download and a pass over the
 * whole library, which is a decision to opt into rather than to discover.
 */
export function defaultVisionConfig(): VisionConfig {
  return {
    faces: { enabled: false, threshold: 0.45, publishLabels: false },
    scene: { enabled: false },
    objects: { enabled: false, threshold: DEFAULT_OBJECT_THRESHOLD },
    tags: { vocabulary: [...DEFAULT_TAG_VOCABULARY], threshold: DEFAULT_TAG_THRESHOLD },
  };
}
