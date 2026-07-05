import { resolveDataSource } from "./data-client";
import { withBasePath } from "./base-path";
import { starkeepTypeFromFilename } from "./file-extension";
import { extractExif } from "../photos-lib/metadata/exif-reader";

export interface PhotoRecord {
  id: string;
  type: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  sync_status: string;
  content_hash: string;
  object_storage_key: string;
  original_filename: string | null;
  parent_id: string | null;
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
  try {
    res = await fetch(url, {
      ...options,
      headers: { ...source.headers, ...options?.headers },
    });
  } catch (err) {
    console.error(`[data-server-client] ${method} ${url} — network error:`, err);
    throw err;
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

  const { url: uploadUrl } = await request<{ url: string }>(
    "/files/presign",
    source,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: objectStorageKey, contentType: mimeType }),
    },
  );

  const s3Res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
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

// No `type` filter: a type-less query is server-scoped to the app's granted
// types, which for Photos are exactly the image types — so this returns every
// image the app can see in one request, across all of image/jpeg/png/heic/…
// rather than a single hardcoded type.
export async function listPhotos(): Promise<PhotoRecord[]> {
  const source = await resolveDataSource();
  const result = await request<{ records: PhotoRecord[] }>(
    "/data/records?limit=500",
    source,
  );
  return result.records;
}

export async function listPhotosSince(updatedAfter: string): Promise<PhotoRecord[]> {
  const source = await resolveDataSource();
  const result = await request<{ records: PhotoRecord[] }>(
    `/data/records?limit=500&updated_after=${encodeURIComponent(updatedAfter)}`,
    source,
  );
  return result.records;
}

export async function getPhotoFileUrl(id: string): Promise<string> {
  const source = await resolveDataSource();
  const result = await request<{ url: string }>(`/data/records/${id}/file-url`, source);
  return result.url;
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


// Sync endpoints are under /sync/* on the data server and require app auth
// (X-Starkeep-App-Id + HMAC). The browser routes through the same-origin
// /api/local-data proxy that adds those headers server-side.
// Same-origin proxy path; must carry the app basePath in cloud (see
// withBasePath). No-op in local dev where BASE_PATH is empty.
const LOCAL_BASE = withBasePath("/api/local-data");

export interface SyncStatus {
  enabled: boolean;
  syncPaused: boolean;
  cloudUrl: string | null;
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastPullError: string | null;
  lastPushError: string | null;
  conflictCount: number;
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const res = await fetch(`${LOCAL_BASE}/sync/status`);
  return res.json() as Promise<SyncStatus>;
}

export async function pauseSync(): Promise<void> {
  await fetch(`${LOCAL_BASE}/sync/pause`, { method: "POST" });
}

export async function resumeSync(): Promise<void> {
  await fetch(`${LOCAL_BASE}/sync/resume`, { method: "POST" });
}

export async function triggerSyncNow(): Promise<void> {
  await fetch(`${LOCAL_BASE}/sync/now`, { method: "POST" });
}
