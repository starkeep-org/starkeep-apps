import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  PhotoProvider,
  PhotoUrlProvider,
  PhotoGrid,
  PhotoViewer,
  usePhotoContext,
} from "@/photos-ui";
import {
  addPhotoFromPath,
  getPhotoFileUrl,
  triggerSyncNow,
  type PhotoRecord,
} from "./src/lib/data-server-client";
import { FORCE_REMOTE } from "./src/lib/data-source-context";
import { AuthGate } from "./src/lib/AuthGate";
import { CloudSetupModal } from "./src/lib/CloudSetupModal";
import { downsizeImage } from "./src/lib/image-utils";
import { resolveDataSource, getDataTarget } from "./src/lib/data-client";
import { photoRecordToAppImage } from "./src/lib/photoRecordToAppImage";
import { usePhotoSync } from "./src/lib/usePhotoSync";


function useFullSizeUrlCache() {
  const [urlMap, setUrlMap] = useState<ReadonlyMap<string, string>>(new Map());
  const loadingRef = useRef<Set<string>>(new Set());

  return useCallback(
    (imageId: string): string | null => {
      const cached = urlMap.get(imageId);
      if (cached) return cached;
      if (loadingRef.current.has(imageId)) return null;

      loadingRef.current.add(imageId);
      getPhotoFileUrl(imageId)
        .then((url) => {
          loadingRef.current.delete(imageId);
          setUrlMap((prev) => new Map(prev).set(imageId, url));
        })
        .catch(() => {
          loadingRef.current.delete(imageId);
        });

      return null;
    },
    [urlMap],
  );
}


type ThumbnailStrategy = "browser" | "local-sharp" | "remote-sharp";

// Resolve where /api/resize lives based on the configured data target. For a
// cloud-served build the SPA is mounted under /apps/photos on the API Gateway
// domain and the route is JWT-gated; for a locally-served build the Next.js
// server serves it at the origin.
async function resolveResizeEndpoint(): Promise<{ url: string; headers: Record<string, string> }> {
  const target = await getDataTarget();
  if (target.kind === "remote") {
    const source = await resolveDataSource();
    return { url: `${source.baseUrl}/api/resize`, headers: source.headers };
  }
  return { url: "/api/resize", headers: {} };
}

async function generateThumbnail(
  record: PhotoRecord,
  file: File,
  thumbnailStrategy: ThumbnailStrategy,
): Promise<void> {
  try {
    const { url, headers: authHeaders } = await resolveResizeEndpoint();
    const target = await getDataTarget();
    const isLocal = target.kind === "local";
    const headers = { "Content-Type": "application/json", ...authHeaders };
    if (thumbnailStrategy === "browser") {
      // Generate thumbnail in-browser using Canvas, then POST it as a new record
      // with content.parentId pointing to the original.
      const result = await downsizeImage(file, 400);
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ targetId: record.id, ownerId: record.owner_id }),
      });
      if (res.ok && isLocal) triggerSyncNow().catch(() => {});
      void result; // generation handled server-side via /api/resize

    } else {
      // For local-sharp and remote-sharp, call /api/resize which runs sharp
      // server-side and creates the thumbnail DataRecord.
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ targetId: record.id, ownerId: record.owner_id }),
      });
      if (res.ok && thumbnailStrategy === "remote-sharp" && isLocal) {
        triggerSyncNow().catch(() => {});
      }
    }
  } catch {
    // Thumbnail generation is best-effort
  }
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", heic: "image/heic",
  heif: "image/heif", avif: "image/avif", tiff: "image/tiff",
};

function PhotosAppInner() {
  const { state, dispatch } = usePhotoContext();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCloudSetup, setShowCloudSetup] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [thumbnailStrategy, setThumbnailStrategy] = useState<ThumbnailStrategy>(
    () => (localStorage.getItem("thumbnail-strategy") as ThumbnailStrategy) ?? "browser",
  );

  const handleStrategyChange = (s: ThumbnailStrategy) => {
    setThumbnailStrategy(s);
    localStorage.setItem("thumbnail-strategy", s);
  };

  // Build the display list. Deduplicate thumbnails per original (keep newest),
  // then show orphan originals (no thumbnail yet) as empty placeholder boxes.
  const allThumbnails = state.images.filter((img) => img.parentId !== null);
  const originals = state.images.filter((img) => img.parentId === null);
  const newestThumbnailByParent = new Map<string, typeof allThumbnails[0]>();
  for (const t of allThumbnails) {
    const parentId = t.parentId!;
    const existing = newestThumbnailByParent.get(parentId);
    if (!existing || t.createdAt > existing.createdAt) newestThumbnailByParent.set(parentId, t);
  }
  const thumbnails = Array.from(newestThumbnailByParent.values());
  const thumbnailedIds = new Set(thumbnails.map((t) => t.parentId!));
  const fallbackOriginals = originals.filter((img) => !thumbnailedIds.has(img.id));
  const displayImages = [...thumbnails, ...fallbackOriginals];

  // Backfill thumbnails for orphan originals. A ref prevents the same ID from
  // being submitted more than once per session, even if the effect re-fires.
  const backfilledRef = useRef(new Set<string>());
  const orphanIds = fallbackOriginals.map((img) => img.id).sort().join(",");
  useEffect(() => {
    if (!orphanIds) return;
    const newIds = orphanIds.split(",").filter((id) => !backfilledRef.current.has(id));
    if (newIds.length === 0) return;
    newIds.forEach((id) => backfilledRef.current.add(id));
    void (async () => {
      const { url, headers: authHeaders } = await resolveResizeEndpoint();
      const headers = { "Content-Type": "application/json", ...authHeaders };
      newIds.forEach((id) => {
        fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ targetId: id }),
        }).catch(() => {});
      });
    })();
  }, [orphanIds]);

  // For the viewer: if a thumbnail was clicked, show its original.
  // If a fallback-original was clicked (no thumbnail exists), show it directly.
  const selectedDisplayImage = state.selectedId
    ? displayImages.find((img) => img.id === state.selectedId) ?? null
    : null;
  const selectedImage = selectedDisplayImage
    ? (selectedDisplayImage.parentId !== null
        ? (state.images.find((img) => img.id === selectedDisplayImage.parentId) ?? selectedDisplayImage)
        : selectedDisplayImage)
    : null;

  usePhotoSync({
    onInitialLoad: (images) => dispatch({ type: "SET_IMAGES", images }),
    onMerge: (images) => dispatch({ type: "UPSERT_IMAGES", images }),
    onLoadingChange: (loading) => dispatch({ type: "SET_LOADING", loading }),
    onError: setError,
  });

  const handleFileSelected = async (file: File) => {
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const fileName = file.name;
      const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
      const mimeType = IMAGE_EXTENSIONS[ext] ?? file.type ?? "application/octet-stream";

      const buf = await file.arrayBuffer();
      const fileBytes = new Uint8Array(buf);
      const { record, deduped } = await addPhotoFromPath(fileName, fileBytes, mimeType, fileName);
      // UPSERT (not APPEND) so a dedup hit — which returns the already-listed
      // record — doesn't add a duplicate row to the grid.
      dispatch({ type: "UPSERT_IMAGES", images: [photoRecordToAppImage(record, null)] });

      if (deduped) {
        setNotice(`"${fileName}" is already in your photos — nothing was added.`);
      }

      // Mark as submitted before generateThumbnail fires so the backfill effect
      // never picks up this original and creates a second thumbnail.
      backfilledRef.current.add(record.id);
      generateThumbnail(record, file, thumbnailStrategy).catch(() => {});
    } catch (err) {
      console.error("[photos] Upload failed:", err);
      setError(err instanceof Error ? err.message : "Failed to add photo");
    } finally {
      setAdding(false);
    }
  };

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const handleAddClick = () => {
    fileInputRef.current?.click();
  };

  const getFullSizeSrc = useFullSizeUrlCache();

  return (
    <PhotoUrlProvider getThumbnailSrc={getFullSizeSrc} getFullSizeSrc={getFullSizeSrc}>
      <div
        style={{
          minHeight: "100vh",
          background: "#111",
          color: "#fff",
          fontFamily: "sans-serif",
        }}
      >
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept={Object.keys(IMAGE_EXTENSIONS).map((e) => `.${e}`).join(",")}
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFileSelected(file);
            e.target.value = "";
          }}
        />

        {/* Toolbar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 20px",
            borderBottom: "1px solid rgba(255,255,255,0.1)",
            position: "sticky",
            top: 0,
            background: "#111",
            zIndex: 100,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 17, letterSpacing: "-0.02em" }}>Photos</span>

          {/* Thumbnail generation strategy */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "#aaa" }}>
            <span style={{ whiteSpace: "nowrap" }}>Thumbnail:</span>
            {(
              [
                { value: "browser", label: "Browser" },
                ...(FORCE_REMOTE
                  ? [{ value: "remote-sharp" as const, label: "Remote Sharp" }]
                  : [{ value: "local-sharp" as const, label: "Local Sharp" }]),
              ] as { value: ThumbnailStrategy; label: string }[]
            ).map(({ value, label }) => (
              <label
                key={value}
                style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", whiteSpace: "nowrap" }}
              >
                <input
                  type="radio"
                  name="thumbnail-strategy"
                  value={value}
                  checked={thumbnailStrategy === value}
                  onChange={() => handleStrategyChange(value)}
                  style={{ accentColor: "#888" }}
                />
                {label}
              </label>
            ))}
          </div>

          {FORCE_REMOTE && (
            <button
              onClick={() => setShowCloudSetup(true)}
              title="Cloud setup"
              style={toolbarButtonStyle}
            >
              ⚙
            </button>
          )}

          <button
            onClick={handleAddClick}
            disabled={adding}
            style={{ ...toolbarButtonStyle, background: "rgba(255,255,255,0.15)" }}
          >
            {adding
              ? (FORCE_REMOTE ? "Uploading…" : "Adding…")
              : (FORCE_REMOTE ? "Upload Photo" : "Add Photo")}
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: "8px 20px",
              background: "rgba(220,50,50,0.15)",
              color: "#f88",
              fontSize: 13,
              borderBottom: "1px solid rgba(220,50,50,0.3)",
            }}
          >
            {error}
          </div>
        )}

        {notice && (
          <div
            role="status"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "8px 20px",
              background: "rgba(255,200,60,0.12)",
              color: "#ffd86b",
              fontSize: 13,
              borderBottom: "1px solid rgba(255,200,60,0.3)",
            }}
          >
            <span>{notice}</span>
            <button
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
              style={{
                background: "transparent",
                border: "none",
                color: "inherit",
                cursor: "pointer",
                fontSize: 16,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        )}

        <PhotoGrid
          images={displayImages}
          loading={state.loading}
          hasMore={false}
          onLoadMore={() => {}}
          onSelect={(id) => dispatch({ type: "SET_SELECTED_ID", id })}
        />

        {selectedImage && (
          <PhotoViewer
            image={selectedImage}
            onClose={() => dispatch({ type: "SET_SELECTED_ID", id: null })}
          />
        )}

        {showCloudSetup && (
          <CloudSetupModal onClose={() => setShowCloudSetup(false)} />
        )}
      </div>
    </PhotoUrlProvider>
  );
}

export function App() {
  return (
    <AuthGate>
      <PhotoProvider>
        <PhotosAppInner />
      </PhotoProvider>
    </AuthGate>
  );
}

const toolbarButtonStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#ddd",
  borderRadius: 4,
  padding: "6px 14px",
  cursor: "pointer",
  fontSize: 13,
};
