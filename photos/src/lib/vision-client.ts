/**
 * Browser-side client for the on-device vision routes.
 *
 * Every path goes through `withBasePath` — in the cloud deploy the app is
 * mounted under `/apps/photos`, and a root-absolute request that skips the
 * prefix leaves the app entirely. These routes answer 501 in the cloud anyway,
 * but a 404 from the wrong origin and a 501 from the right one look nothing
 * alike when something goes wrong.
 *
 * `unavailable` is a first-class result rather than an error: a Photos serving
 * from a remote data server, or a local one that has never fetched the models,
 * is a normal state the UI renders, not a failure it reports.
 */

import { withBasePath } from "./base-path";

export interface VisionConfigShape {
  faces: { enabled: boolean; threshold: number; publishLabels: boolean };
  scene: { enabled: boolean };
  objects: { enabled: boolean; threshold: number };
  tags: { vocabulary: string[]; threshold: number };
  search: { denseFloor: number };
}

export interface VisionScanState {
  running: boolean;
  eligible: number;
  skipped: number;
  processed: { faces?: number; scene?: number; objects?: number };
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export type VisionModelGroupName = "faces" | "scene" | "objects" | "search";

export interface VisionModelDownload {
  running: boolean;
  /** Which group is in flight, or was last. */
  group: VisionModelGroupName | null;
  /** Verified bytes on disk plus bytes of the file in flight. */
  bytesReceived: number;
  bytesTotal: number;
  currentFile: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** One model group's install state, as the panel renders it. */
export interface VisionModelGroup {
  installed: boolean;
  missing: string[];
  /** Bytes an install would transfer — quoted before anyone commits to it. */
  missingBytes: number;
  dir: string;
  fetchCommand: string;
  /** One line of licence, and whether installing needs an explicit acceptance. */
  licence: string;
  needsAck: boolean;
  label: string;
  purpose: string;
  pack: { name: string; files: string[]; totalBytes: number };
}

export interface VisionTaskStatus<Store> {
  models: VisionModelGroup;
  store: Store;
}

export interface VisionFaceStore {
  processed: number;
  sidecarsOnDisk: number;
  imagesWithFaces: number;
  facesFound: number;
  people: number;
  namedPeople: number;
}

export interface VisionObjectStore {
  processed: number;
  sidecarsOnDisk: number;
  detections: number;
  classes: number;
  imagesWithObjects: number;
}

export interface VisionSceneStore {
  processed: number;
  sidecarsOnDisk: number;
  /** Rows in the compacted index — what search actually ranks against. */
  indexed: number;
  indexReady: boolean;
}

export interface VisionStatus {
  config: VisionConfigShape;
  worker: { built: boolean; path: string; buildCommand: string };
  scan: VisionScanState;
  /** One transfer at a time across all groups; `group` says which. */
  download: VisionModelDownload;
  tasks: {
    faces: VisionTaskStatus<VisionFaceStore>;
    scene: VisionTaskStatus<VisionSceneStore>;
    objects: VisionTaskStatus<VisionObjectStore>;
  };
  tags: {
    count: number;
    threshold: number;
    embedded: boolean;
    stale: boolean;
  };
  search: {
    models: VisionModelGroup;
    /** The worker exits when idle, so this is not a health check. */
    workerRunning: boolean;
    workerBuilt: boolean;
    ready: boolean;
  };
}

export interface VisionFaceRef {
  recordId: string;
  faceIndex: number;
  score: number;
}

export interface VisionPerson {
  id: string;
  name: string;
  createdAt: string;
  faceCount: number;
  faces: VisionFaceRef[];
}

export interface DetectedFaceView {
  index: number;
  /** `[x, y, width, height]` in display-orientation pixels. */
  bbox: [number, number, number, number];
  score: number;
  personId: string | null;
  name: string;
}

export interface ImageFaces {
  processed: boolean;
  width?: number;
  height?: number;
  faces: DetectedFaceView[];
}

/** 501 means "this build is not on-device" — the one status the UI must not treat as broken. */
export const VISION_UNAVAILABLE = Symbol("vision-unavailable");
export type MaybeUnavailable<T> = T | typeof VISION_UNAVAILABLE;

async function get<T>(path: string): Promise<MaybeUnavailable<T>> {
  const res = await fetch(withBasePath(path));
  if (res.status === 501) return VISION_UNAVAILABLE;
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as T;
}

async function send<T>(path: string, method: string, body: unknown): Promise<MaybeUnavailable<T>> {
  const res = await fetch(withBasePath(path), {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 501) return VISION_UNAVAILABLE;
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as T;
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    /* fall through to the status line */
  }
  return `${res.status} ${res.statusText}`;
}

export function fetchVisionStatus(): Promise<MaybeUnavailable<VisionStatus>> {
  return get<VisionStatus>("/api/vision/status");
}

export function updateVisionConfig(
  patch: {
    faces?: Partial<VisionConfigShape["faces"]>;
    scene?: Partial<VisionConfigShape["scene"]>;
    objects?: Partial<VisionConfigShape["objects"]>;
  },
): Promise<MaybeUnavailable<{ config: VisionConfigShape; warning?: string }>> {
  return send("/api/vision/config", "PUT", patch);
}

/**
 * Starts one group's model download.
 *
 * `acceptLicence` is sent explicitly rather than implied by the call: the route
 * refuses without it for a restricted group, and the flag is what ties the request
 * back to the notice the user was shown. Sent for every group because the caller
 * showed a licence line for every group — the route is what decides whether it was
 * *required*.
 */
export function startVisionModelDownload(
  group: VisionModelGroupName,
): Promise<MaybeUnavailable<{ download: VisionModelDownload }>> {
  return send("/api/vision/models", "POST", {
    action: "download",
    group,
    acceptLicence: true,
  });
}

export function startVisionScan(): Promise<MaybeUnavailable<{ scan: VisionScanState }>> {
  return send("/api/vision/scan", "POST", { action: "start" });
}

export function stopVisionScan(): Promise<MaybeUnavailable<{ scan: VisionScanState }>> {
  return send("/api/vision/scan", "POST", { action: "stop" });
}

export function fetchImageFaces(recordId: string): Promise<MaybeUnavailable<ImageFaces>> {
  return get<ImageFaces>(`/api/vision/faces/${encodeURIComponent(recordId)}`);
}

export interface DetectedObjectView {
  index: number;
  /** `[x, y, width, height]` in display-orientation pixels. */
  bbox: [number, number, number, number];
  score: number;
  /** Resolved server-side — the sidecar stores a class index, not a name. */
  name: string;
}

export interface ImageObjects {
  processed: boolean;
  width?: number;
  height?: number;
  objects: DetectedObjectView[];
}

export function fetchImageObjects(recordId: string): Promise<MaybeUnavailable<ImageObjects>> {
  return get<ImageObjects>(`/api/vision/objects/${encodeURIComponent(recordId)}`);
}

export function fetchPeople(): Promise<MaybeUnavailable<{ people: VisionPerson[] }>> {
  return get<{ people: VisionPerson[] }>("/api/vision/people");
}

export type PeopleAction =
  | { action: "rename"; personId: string; name: string }
  | { action: "merge"; targetId: string; sourceIds: string[] }
  | { action: "split"; faces: VisionFaceRef[] }
  | { action: "recluster" };

export function mutatePeople(
  body: PeopleAction,
): Promise<MaybeUnavailable<{ people: VisionPerson[]; warning?: string }>> {
  return send("/api/vision/people", "PUT", body);
}

/** URL of a single face's crop. Rendered directly into an `<img src>`. */
export function faceCropUrl(ref: VisionFaceRef): string {
  return withBasePath(
    `/api/vision/face-crop/${encodeURIComponent(ref.recordId)}?face=${ref.faceIndex}`,
  );
}

// ---------------------------------------------------------------------------
// Search (plan §5)
// ---------------------------------------------------------------------------

/** One interpretation the parse made, rendered as a removable chip (§5.2). */
export interface VisionSearchTerm {
  kind: "person" | "object";
  id: string;
  /** How many of this class the query asked for, when it said so. */
  count: number | null;
  /** Stable identity, passed back as `drop` to dismiss this interpretation. */
  key: string;
  /** What the user typed. */
  matched: string;
  /** The canonical name. */
  label: string;
}

export interface VisionSearchResult {
  recordId: string;
  score: number;
  structured: number;
  /** Normalized dense score in [0, 1], or null when the query had no residual. */
  dense: number | null;
  matched: VisionSearchTerm[];
}

export interface VisionSearchResponse {
  raw: string;
  terms: VisionSearchTerm[];
  residual: string;
  results: VisionSearchResult[];
  bands: Array<{ terms: VisionSearchTerm[]; results: VisionSearchResult[] }>;
  total: number;
  /** Why the dense half could not run, when it could not. */
  denseUnavailable: string | null;
}

/**
 * Run a search.
 *
 * `dropped` carries the dismissed chips in the query string rather than in
 * stored state, because dropping a parse is a property of *this* search: "Rose
 * is never a person" would be a different feature with a different lifetime.
 */
export function searchVision(
  query: string,
  options: { dropped?: readonly string[]; limit?: number } = {},
): Promise<MaybeUnavailable<VisionSearchResponse>> {
  const params = new URLSearchParams({ q: query });
  for (const key of options.dropped ?? []) params.append("drop", key);
  if (options.limit) params.set("limit", String(options.limit));
  return get<VisionSearchResponse>(`/api/vision/search?${params}`);
}

// ---------------------------------------------------------------------------
// Tags (plan §7)
// ---------------------------------------------------------------------------

export interface PhotoTagView {
  tag: string;
  /**
   * `suggested` — derived, untouched. `confirmed` — derived and kept by the user.
   * `added` — typed by the user. Only the last two are publishable, since an
   * uncalibrated score must not become another app's ground truth.
   */
  source: "suggested" | "confirmed" | "added";
  score: number | null;
}

export interface PhotoTagsResponse {
  /** False when the photo has no scene embedding yet — user tags still apply. */
  described: boolean;
  tags: PhotoTagView[];
  /** Near-misses below the threshold, for a "did you mean" affordance. */
  suggestions: Array<{ tag: string; score: number }>;
  edits: { added: string[]; removed: string[] };
}

export function fetchPhotoTags(recordId: string): Promise<MaybeUnavailable<PhotoTagsResponse>> {
  return get<PhotoTagsResponse>(`/api/vision/tags/${encodeURIComponent(recordId)}`);
}

/**
 * Save the whole diff, not a toggle.
 *
 * The diff is the unit that syncs, so a partial update would need a
 * read-modify-write here *and* an LWW resolution in the table. A client that has
 * rendered the tags already knows the intended state.
 */
export function savePhotoTags(
  recordId: string,
  edits: { added: string[]; removed: string[] },
): Promise<MaybeUnavailable<PhotoTagsResponse>> {
  return send(`/api/vision/tags/${encodeURIComponent(recordId)}`, "PUT", edits);
}

export interface VocabularyResponse {
  vocabulary: string[];
  threshold: number;
  /** Whether text embeddings exist for the configured list. */
  embedded: boolean;
  /** Built for a different list than the one configured. */
  stale?: boolean;
}

export function fetchVocabulary(): Promise<MaybeUnavailable<VocabularyResponse>> {
  return get<VocabularyResponse>("/api/vision/vocabulary");
}

/**
 * Replace the vocabulary and rebuild its embeddings.
 *
 * Cheap by design (§7): one text encode per tag and then a dot product per
 * (image, tag). No scan, no image decode.
 */
export function saveVocabulary(
  patch: { vocabulary?: string[]; threshold?: number },
): Promise<MaybeUnavailable<VocabularyResponse>> {
  return send("/api/vision/vocabulary", "PUT", patch);
}
