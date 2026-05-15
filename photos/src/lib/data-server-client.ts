import { resolveDataSource, type DataSourceMode } from "./data-client";

export interface PhotoRecord {
  id: string;
  type: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  owner_id: string;
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

export async function addPhotoFromPath(
  _filePath: string,
  fileBytes: Uint8Array,
  mimeType: string,
  fileName: string,
  mode: DataSourceMode,
): Promise<PhotoRecord> {
  const source = await resolveDataSource(mode);

  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < fileBytes.length; i += chunkSize) {
    binary += String.fromCharCode(...fileBytes.subarray(i, i + chunkSize));
  }
  const fileBase64 = btoa(binary);
  const body: Record<string, unknown> = {
    type: "image",
    fileName,
    contentType: mimeType,
    fileBase64,
  };

  const result = await request<{ record: PhotoRecord }>("/data/records", source, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return result.record;
}

export async function listPhotos(mode: DataSourceMode): Promise<PhotoRecord[]> {
  const source = await resolveDataSource(mode);
  const result = await request<{ records: PhotoRecord[] }>(
    "/data/records?type=image&limit=500",
    source,
  );
  return result.records;
}

export async function listPhotosSince(updatedAfter: string, mode: DataSourceMode): Promise<PhotoRecord[]> {
  const source = await resolveDataSource(mode);
  const result = await request<{ records: PhotoRecord[] }>(
    `/data/records?type=image&limit=500&updated_after=${encodeURIComponent(updatedAfter)}`,
    source,
  );
  return result.records;
}

export async function getPhotoFileUrl(id: string, mode: DataSourceMode): Promise<string> {
  const source = await resolveDataSource(mode);
  const result = await request<{ url: string }>(`/data/records/${id}/file-url`, source);
  return result.url;
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
  mode: DataSourceMode,
): Promise<FileRef> {
  const source = await resolveDataSource(mode);
  return request<FileRef>(`/data/files?type=${encodeURIComponent(typeId)}`, source, {
    method: "POST",
    headers: { "Content-Type": mimeType },
    body: bytes as unknown as BodyInit,
  });
}

export async function postMetadata(
  targetId: string,
  targetType: string,
  generatorId: string,
  generatorVersion: number,
  value: Record<string, unknown>,
  mode: DataSourceMode,
  fileRef?: FileRef,
): Promise<void> {
  const source = await resolveDataSource(mode);
  await request<{ ok: true }>("/data/metadata", source, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId,
      targetType,
      generatorId,
      generatorVersion,
      value,
      ...(fileRef && {
        objectStorageKey: fileRef.key,
        contentHash: fileRef.contentHash,
        mimeType: fileRef.mimeType,
        sizeBytes: fileRef.sizeBytes,
      }),
    }),
  });
}

const LOCAL_BASE = "http://127.0.0.1:9820";

export interface SyncStatus {
  enabled: boolean;
  syncPaused: boolean;
  cloudUrl: string | null;
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastError: string | null;
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

export async function triggerGeneration(
  targetId: string,
  generatorId: string,
  mode: DataSourceMode,
): Promise<void> {
  if (mode === "local") {
    // Handled by the photos-web Next.js API route, which runs sharp server-side
    // and delegates persistence to data-server's storage HTTP APIs.
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId, generatorId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(`Generate failed: ${body.error ?? res.statusText}`);
    }
    return;
  }
  const source = await resolveDataSource(mode);
  await request<{ ok: true }>("/data/generate", source, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId, generatorId }),
  });
}

export async function triggerSyncNow(): Promise<void> {
  await fetch(`${LOCAL_BASE}/sync/now`, { method: "POST" });
}

export async function getMetadataFileUrl(
  targetId: string,
  generatorId: string,
  mode: DataSourceMode,
): Promise<string | null> {
  const source = await resolveDataSource(mode);
  const encodedGeneratorId = encodeURIComponent(generatorId);
  try {
    const result = await request<{ url: string }>(
      `/data/metadata/${targetId}/${encodedGeneratorId}/file-url`,
      source,
    );
    return result.url;
  } catch {
    return null;
  }
}
