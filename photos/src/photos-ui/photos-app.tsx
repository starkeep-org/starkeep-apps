import React, { useState, useEffect, useRef } from "react";
import { PhotoProvider } from "./context/photo-context";
import { PhotoUrlProvider } from "./context/photo-url-context";
import { usePhotos } from "./hooks/use-photos";
import { PhotoGrid } from "./components/grid/photo-grid";
import { PhotoViewer } from "./components/viewer/photo-viewer";
import { UploadZone } from "./components/upload/upload-zone";
import { GoogleImportPanel } from "./components/google/google-import-panel";
import { useStyleGraphic } from "./hooks/use-style-graphic";
import type { AppImage } from "@/photos-lib";
import { withBasePath } from "@/lib/base-path";

function PhotosAppInner() {
  const {
    images,
    loading,
    nextCursor,
    loadMore,
    uploadPhoto,
    selectImage,
    fetchPhotos,
    fetchImage,
  } = usePhotos();

  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showGoogleImport, setShowGoogleImport] = useState(false);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const styleGraphic = useStyleGraphic();
  const styleFileInputRef = useRef<HTMLInputElement>(null);
  // The viewer always shows the original image (parentId === ""), fetched on demand
  const [viewerImage, setViewerImage] = useState<AppImage | null>(null);

  const handleSelect = async (imageId: string) => {
    selectImage(imageId);
    const item = images.find((img) => img.id === imageId);
    if (!item) return;
    if (item.parentId !== null) {
      const original = await fetchImage(item.parentId);
      setViewerImage(original);
    } else {
      setViewerImage(item);
    }
  };

  const handleCloseViewer = () => {
    selectImage(null);
    setViewerImage(null);
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const result = await uploadPhoto(file, file.name);
      if (result?.deduped) {
        setUploadNotice(`"${file.name}" is already in your photos — nothing was added.`);
      } else if (result === null) {
        setUploadNotice(`Upload failed for "${file.name}".`);
      } else {
        setUploadNotice(null);
      }
    } finally {
      setUploading(false);
    }
  };

  useEffect(() => {
    if (!uploadNotice) return;
    const timer = setTimeout(() => setUploadNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [uploadNotice]);

  const handleImportComplete = (_count: number) => {
    void fetchPhotos();
    setShowGoogleImport(false);
  };

  // Backfill thumbnails for orphan originals. A ref ensures each ID is only
  // submitted once per session — prevents loops when fetchPhotos refreshes state.
  const backfilledRef = useRef(new Set<string>());
  const orphanIds = images
    .filter((img) => img.parentId === null)
    .map((img) => img.id)
    .sort()
    .join(",");
  useEffect(() => {
    if (!orphanIds) return;
    const newIds = orphanIds.split(",").filter((id) => !backfilledRef.current.has(id));
    if (newIds.length === 0) return;
    newIds.forEach((id) => backfilledRef.current.add(id));
    newIds.forEach((id) => {
      fetch(withBasePath("/api/resize"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: id }),
      }).catch(() => {});
    });
  }, [orphanIds]);

  return (
    <div style={{ minHeight: "100vh", background: "#111", color: "#fff", fontFamily: "sans-serif" }}>
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
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setShowGoogleImport(true)}
            style={toolbarButtonStyle}
          >
            Import from Google
          </button>
          <button
            onClick={() => setShowUpload(!showUpload)}
            style={{ ...toolbarButtonStyle, background: "rgba(255,255,255,0.15)" }}
          >
            Upload
          </button>
        </div>
      </div>

      {/* Upload zone */}
      {showUpload && (
        <div style={{ padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
          <UploadZone onUpload={handleUpload} uploading={uploading} />
        </div>
      )}

      {uploadNotice && (
        <div
          role="status"
          style={{
            margin: "12px 20px",
            padding: "10px 14px",
            borderRadius: 6,
            background: "rgba(255, 200, 60, 0.15)",
            border: "1px solid rgba(255, 200, 60, 0.4)",
            color: "#ffd86b",
            fontSize: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>{uploadNotice}</span>
          <button
            onClick={() => setUploadNotice(null)}
            style={{
              background: "transparent",
              border: "none",
              color: "inherit",
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
            }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* App-syncable style graphic banner */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 20px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          minHeight: 56,
        }}
      >
        {styleGraphic.url ? (
          <img
            src={styleGraphic.url}
            alt="Style graphic"
            style={{ height: 36, borderRadius: 4, objectFit: "cover" }}
          />
        ) : (
          <span style={{ color: "#888", fontSize: 12 }}>
            {styleGraphic.loading ? "Loading style graphic…" : "No style graphic set"}
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <input
            ref={styleFileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void styleGraphic.upload(file);
              e.target.value = "";
            }}
          />
          <button
            style={toolbarButtonStyle}
            onClick={() => styleFileInputRef.current?.click()}
          >
            {styleGraphic.url ? "Change" : "Set"} style graphic
          </button>
          {styleGraphic.url && (
            <button
              style={toolbarButtonStyle}
              onClick={() => void styleGraphic.remove()}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {/* Grid shows thumbnail records */}
      <PhotoGrid
        images={images}
        loading={loading}
        hasMore={!!nextCursor}
        onLoadMore={loadMore}
        onSelect={(id) => void handleSelect(id)}
      />

      {/* Viewer overlay — receives the original image (parentId === "") */}
      {viewerImage && (
        <PhotoViewer
          image={viewerImage}
          onClose={handleCloseViewer}
        />
      )}

      {/* Google Import panel */}
      {showGoogleImport && (
        <GoogleImportPanel
          onImportComplete={handleImportComplete}
          onClose={() => setShowGoogleImport(false)}
        />
      )}
    </div>
  );
}

export function PhotosApp() {
  return (
    <PhotoProvider>
      <PhotoUrlProvider>
        <PhotosAppInner />
      </PhotoUrlProvider>
    </PhotoProvider>
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
