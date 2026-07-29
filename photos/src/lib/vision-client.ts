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
}

export interface VisionScanState {
  running: boolean;
  eligible: number;
  skipped: number;
  processed: { faces?: number };
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface VisionStatus {
  config: VisionConfigShape;
  models: { installed: boolean; missing: string[]; dir: string; fetchCommand: string };
  worker: { built: boolean; path: string; buildCommand: string };
  scan: VisionScanState;
  store: {
    processed: number;
    sidecarsOnDisk: number;
    imagesWithFaces: number;
    facesFound: number;
    people: number;
    namedPeople: number;
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
  patch: { faces: Partial<VisionConfigShape["faces"]> },
): Promise<MaybeUnavailable<{ config: VisionConfigShape; warning?: string }>> {
  return send("/api/vision/config", "PUT", patch);
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
