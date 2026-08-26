import { resolveDataSource } from "./data-client";
import { withBasePath } from "./base-path";
import { starkeepTypeFromFilename } from "./file-extension";
import { extractExif } from "../photos-lib/metadata/exif-reader";
import { RENDITION_LABEL_REF } from "../photos-lib/image-processing/publish-renditions";
import type { RenditionChoice } from "../photos-lib/rendition-resolution";

export interface PhotoRecord {
  id: string;
  type: string;
  /** Advisory MIME. Folder-watched local files intentionally store null. */
  mime_type: string | null;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  sync_status: string;
  content_hash: string;
  object_storage_key: string;
  original_filename: string | null;
  parent_id: string | null;
  /**
   * Per-category metadata (dimensions, EXIF, …) embedded by the data server
   * when the list is fetched with ?include=metadata. `undefined` when the field
   * wasn't requested; `null` when requested but the record has no metadata row
   * yet (e.g. bytes ingested by a path that doesn't extract metadata, pending
   * backfill).
   */
  metadata?: PhotoMetadataRow | null;
  /**
   * Renditions the server resolved for this record, keyed by the pixel size
   * that was requested (`?variant=…&variantLongEdge=400,1280`).
   *
   * Absent unless asked for. The client asks in pixels and looks up what it
   * asked for — the *classes* these came from are never named on the wire in
   * either direction.
   */
  variants?: Record<
    string,
    { id: string; type: string; object_storage_key: string; width: number; height: number; long_edge: number; url?: string }
  >;
  video_renditions?: Record<
    string,
    {
      poster?: VideoRenditionEntry;
      playback?: VideoRenditionEntry;
    }
  >;
  /**
   * Cross-app labels, embedded when the list is fetched with
   * `?include=labels`. `undefined` when not requested; `[]` when requested and
   * no app has labelled the record — absence of labels is an empty set, not an
   * unknown, which is the opposite of `metadata` above.
   *
   * Includes *every* app's labels on the record, not just Photos'. Any app
   * that can read the type sees them all.
   */
  labels?: PhotoLabel[];
  /**
   * Per requested size: the rung this record should have and what to paint
   * meanwhile, resolved by Photos' own list route against the ladder.
   *
   * Stills only. See `AppImage.renditions` for why video keeps `variants`.
   */
  renditions?: Record<string, RenditionChoice>;
}

export interface VideoRenditionEntry {
  id: string;
  type: string;
  label_value: string;
  object_storage_key: string;
  width: number;
  height: number;
  long_edge: number;
  available_here: boolean;
  url?: string;
}

/**
 * One cross-app label on a record, as the data server renders it.
 *
 * One row per `(record, app, key, value)` — a key is set-valued, so the same
 * `app_id`/`key` can appear more than once in a record's `labels` with different
 * values. Code that reaches for `.find()` on a key is assuming otherwise.
 */
export interface PhotoLabel {
  app_id: string;
  key: string;
  /** Never null: a bare flag (`thumbnail`, `crop`) is the empty string. */
  value: string;
  /** Wire/UI rendering of `<app_id>/<key>`; storage has no such string. */
  label: string;
}

/**
 * Image metadata row returned alongside a PhotoRecord (mirrors the columns
 * on shared_record_image_metadata).
 */
export interface PhotoMetadataRow {
  recordId: string;
  width?: number;
  height?: number;
  captured_at?: string | null;
  camera_make?: string | null;
  camera_model?: string | null;
  f_number?: number | null;
  exposure_time?: string | null;
  iso?: number | null;
  lens_model?: string | null;
  gps_lat?: number | null;
  gps_lon?: number | null;
  orientation?: number | null;
  /** Base64 ThumbHash — the inline, zero-request placeholder. */
  thumb_hash?: string | null;
}

// Statuses that mean the request was shed before our handler ever ran (API
// Gateway / Lambda throttling), so retrying is safe for any method — the
// server never saw the request. Anything else (4xx, 500) reflects an actual
// handler outcome and is not retried.
const RETRYABLE_STATUSES = new Set([429, 503]);
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 300;
const RETRY_CAP_MS = 4000;

/**
 * Backoff for retry `attempt` (0-based): full jitter, uniform in
 * [0, min(cap, base * 2^attempt)]. A numeric Retry-After header (seconds)
 * overrides the jitter, still capped.
 */
export function retryDelayMs(attempt: number, retryAfterHeader?: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, RETRY_CAP_MS);
    }
  }
  return Math.random() * Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request<T>(
  path: string,
  source: { baseUrl: string; headers: Record<string, string> },
  options?: RequestInit,
): Promise<T> {
  const method = options?.method ?? "GET";
  const url = `${source.baseUrl}${path}`;
  const hasAuth = !!source.headers["Authorization"];
  console.debug(`[data-server-client] ${method} ${url} (auth: ${hasAuth})`);

  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, {
        ...options,
        headers: { ...source.headers, ...options?.headers },
      });
    } catch (err) {
      console.error(`[data-server-client] ${method} ${url} — network error:`, err);
      throw err;
    }
    if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt >= MAX_RETRIES) break;
    const delay = retryDelayMs(attempt, res.headers?.get?.("retry-after"));
    console.warn(
      `[data-server-client] ${method} ${url} → ${res.status} (throttled), retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay)}ms`,
    );
    await sleep(delay);
  }

  console.debug(`[data-server-client] ${method} ${url} → ${res.status}`);
  if (!res.ok) {
    let message = res.statusText;
    let rawBody = "";
    try {
      rawBody = await res.text();
      const parsed = JSON.parse(rawBody) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {}
    console.error(`[data-server-client] ${method} ${url} → ${res.status}:`, message, rawBody ? `(body: ${rawBody.slice(0, 500)})` : "");
    throw new Error(`Data server ${method} ${path} → ${res.status}: ${message}`);
  }
  return res.json() as Promise<T>;
}

function dataRecordObjectKey(typeId: string, contentHash: string): string {
  return `shared/${typeId}/${contentHash.slice(0, 2)}/${contentHash}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export async function addPhotoFromPath(
  _filePath: string,
  fileBytes: Uint8Array,
  mimeType: string,
  fileName: string,
): Promise<{ record: PhotoRecord; deduped: boolean }> {
  const source = await resolveDataSource();

  // Upload via presigned S3 PUT, then register by content hash — bypasses the
  // API Gateway ~7 MB cap on inline JSON bodies. This is the canonical
  // client-side add-photo flow.
  const contentHash = await sha256Hex(fileBytes);
  const objectStorageKey = dataRecordObjectKey("image", contentHash);

  const presign = await request<{
    url: string;
    checksumSha256?: string;
    storageClass?: string;
    tagging?: Record<string, string>;
  }>("/files/presign", source, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: objectStorageKey,
      contentType: mimeType,
      // The original is the one thing in the library that can tolerate a slow
      // read: once its derived ladder exists, nothing interactive ever needs
      // it — export, print and re-derivation do, and all three can wait.
      //
      // Declaring `archive` does not freeze anything by itself. It tags the
      // object; the transition happens only after the archive gate confirms
      // the ladder is complete and the hold period has passed.
      intent: "archive",
    }),
  });

  const s3Res = await fetch(presign.url, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      // Mandatory when present: each is inside the signature, so dropping one
      // fails the request rather than uploading something unverified, untiered
      // or untagged.
      ...(presign.checksumSha256 ? { "x-amz-checksum-sha256": presign.checksumSha256 } : {}),
      ...(presign.storageClass ? { "x-amz-storage-class": presign.storageClass } : {}),
      ...(presign.tagging && Object.keys(presign.tagging).length > 0
        ? {
            "x-amz-tagging": Object.entries(presign.tagging)
              .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
              .join("&"),
          }
        : {}),
    },
    body: fileBytes as unknown as BodyInit,
  });
  if (!s3Res.ok) {
    throw new Error(`S3 PUT failed: ${s3Res.status} ${s3Res.statusText}`);
  }

  const result = await request<{ record: PhotoRecord; deduped?: boolean }>("/data/records", source, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: starkeepTypeFromFilename(fileName),
      fileName,
      contentType: mimeType,
      contentHash,
      sizeBytes: fileBytes.byteLength,
    }),
  });

  // Write EXIF + dimensions into the shared image metadata table. Without this
  // the mounted UI's uploads carried no width/height/EXIF (the metadataWrite
  // the manifest requests). Extraction runs in the browser — dimensions via
  // createImageBitmap, EXIF via exifr — so it works through the same `source`
  // proxy as the rest of this flow (preserving the local/remote selection).
  // Best-effort: a metadata failure must not fail the upload (the record +
  // bytes are durable).
  try {
    const metadata = await extractImageMetadata(fileBytes, mimeType);
    await request(`/data/records/${result.record.id}/metadata`, source, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typeId: "image", metadata }),
    });
  } catch (err) {
    console.warn("[data-server-client] image metadata write failed:", err);
  }

  return { record: result.record, deduped: result.deduped === true };
}

/**
 * Extract image dimensions + EXIF in the browser and map them to the
 * shared_record_image_metadata columns. Null/undefined fields are omitted so
 * the row only carries what was actually read.
 */
async function extractImageMetadata(
  fileBytes: Uint8Array,
  mimeType: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  // Dimensions via createImageBitmap (browser-native decode). Best-effort:
  // formats the browser can't decode (some HEIC) just yield no width/height.
  try {
    const blob = new Blob([fileBytes as unknown as BlobPart], { type: mimeType });
    const bitmap = await createImageBitmap(blob);
    out.width = bitmap.width;
    out.height = bitmap.height;
    bitmap.close();
  } catch {
    /* leave width/height unset */
  }

  const exif = await extractExif(fileBytes);
  const exifMap: Record<string, unknown> = {
    captured_at: exif.dateTakenRaw,
    camera_make: exif.cameraMake,
    camera_model: exif.cameraModel,
    f_number: exif.fNumber,
    exposure_time: exif.exposureTime,
    iso: exif.iso,
    lens_model: exif.lensModel,
    gps_lat: exif.gpsLat,
    gps_lon: exif.gpsLon,
    orientation: exif.orientation,
  };
  for (const [k, v] of Object.entries(exifMap)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * The library view is fetched from Photos' own list route, not from the generic
 * data-plane proxy.
 *
 * Both go to the same place — every data-plane call is signed server-side by
 * this app and forwarded to whichever data server the deployment configured —
 * so this is not an extra hop. The difference is that Photos' route resolves
 * renditions against the ladder before answering, which the data server must
 * not do because it must never learn what a size class is.
 *
 * What that buys the client is the thing a resolved variant cannot say: for
 * each size asked for, the rung this record *should* have, whether it exists
 * yet, and the largest smaller rung to paint meanwhile. The page still excludes
 * renditions themselves — with a ladder, a 60k-item library is 300k+ records
 * and a page mixing them is a page the client cannot read to the end of.
 *
 * No size class is named in either direction. The client asks in pixels.
 */
function libraryQuery(extra = ""): string {
  return `/api/photos/library?targets=${LIBRARY_VARIANT_TARGETS.join(",")}${extra}`;
}

/**
 * The pixel sizes the library view asks for.
 *
 * A tile at 3× device pixel ratio, and a large-viewport size for the opened
 * view. Deliberately fixed rather than measured per client: they ride a list
 * request made before anything is laid out, and asking for the exact viewport
 * would mean a different cache key per window size for no visible benefit.
 * The viewer refines with a measured request when it needs to.
 */
export const LIBRARY_VARIANT_TARGETS = [540, 2048];

// No `type` filter: a type-less query is server-scoped to the app's granted
// types, which for Photos are exactly the image types — so this returns every
// image the app can see in one request, across all of image/jpeg/png/heic/…
// rather than a single hardcoded type.
export async function listPhotos(): Promise<PhotoRecord[]> {
  const result = await requestOwnApi<{ records: PhotoRecord[] }>(libraryQuery());
  return result.records;
}

export async function listPhotosSince(updatedAfter: string): Promise<PhotoRecord[]> {
  const result = await requestOwnApi<{ records: PhotoRecord[] }>(
    libraryQuery(`&updated_after=${encodeURIComponent(updatedAfter)}`),
  );
  return result.records;
}

/**
 * Fetch one of Photos' own Next routes, same-origin.
 *
 * `withBasePath` is not optional: in the cloud the SPA is mounted under
 * `/apps/photos`, and a bare absolute path misses the app entirely and 404s at
 * the gateway. Locally the prefix is empty and this is a no-op.
 */
async function requestOwnApi<T>(path: string): Promise<T> {
  const res = await fetch(withBasePath(path), { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as T;
}

export async function getPhotoFileUrl(id: string): Promise<string> {
  const source = await resolveDataSource();
  const result = await request<{ url: string }>(`/data/records/${id}/file-url`, source);
  return result.url;
}

/** Server-side batch cap; chunk client-side so callers can pass any count. */
export const FILE_URL_BATCH_MAX = 100;

/**
 * Resolve signed file URLs for many records in one round trip per chunk
 * (POST /data/records/file-urls) instead of one per record — the per-photo
 * file-url fan-out is what saturates the cloud Lambda concurrency pool.
 * Chunks run sequentially on purpose. Ids the server omitted (unknown,
 * unreadable, no file) are simply absent from the returned map.
 */
export async function getPhotoFileUrls(ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const source = await resolveDataSource();
  for (let i = 0; i < unique.length; i += FILE_URL_BATCH_MAX) {
    const chunk = unique.slice(i, i + FILE_URL_BATCH_MAX);
    const result = await request<{ urls: Record<string, { url: string }> }>(
      "/data/records/file-urls",
      source,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: chunk }),
      },
    );
    for (const [id, entry] of Object.entries(result.urls)) out.set(id, entry.url);
  }
  return out;
}

/**
 * Backfill the shared image metadata for a record that has none. Records can
 * enter the system through paths that don't extract metadata (notably the LDS
 * folder watcher, by design), so their width/height/EXIF are absent. This
 * decodes the stored bytes, runs the same extraction as upload, and writes the
 * row. Best-effort: any failure is swallowed by the caller. Returns true if a
 * non-empty metadata row was written.
 */
export async function backfillImageMetadata(id: string, mimeType: string): Promise<boolean> {
  const source = await resolveDataSource();
  const { url } = await request<{ url: string }>(`/data/records/${id}/file-url`, source);
  const res = await fetch(url);
  if (!res.ok) return false;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const metadata = await extractImageMetadata(bytes, mimeType || "image/jpeg");
  if (Object.keys(metadata).length === 0) return false;
  await request(`/data/records/${id}/metadata`, source, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ typeId: "image", metadata }),
  });
  return true;
}

export interface ImageEnriched {
  record_id?: string;
  caption?: string | null;
  title?: string | null;
  date_taken_override?: string | null;
}

export interface FileRef {
  key: string;
  contentHash: string;
  mimeType: string;
  sizeBytes: number;
}

export async function uploadFile(
  bytes: Uint8Array,
  mimeType: string,
  typeId: string,
): Promise<FileRef> {
  const source = await resolveDataSource();
  return request<FileRef>(`/data/files?type=${encodeURIComponent(typeId)}`, source, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: bytes as unknown as BodyInit,
  });
}
