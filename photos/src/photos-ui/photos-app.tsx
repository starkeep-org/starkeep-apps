import React, { useState, useEffect, useRef } from "react";
import { PhotoProvider } from "./context/photo-context";
import { PhotoUrlProvider } from "./context/photo-url-context";
import { usePhotos } from "./hooks/use-photos";
import { PhotoGrid } from "./components/grid/photo-grid";
import { PhotoViewer } from "./components/viewer/photo-viewer";
import { UploadZone } from "./components/upload/upload-zone";
import { GoogleImportPanel } from "./components/google/google-import-panel";
import type { AppImage } from "@/photos-lib";

function PhotosAppInner() {
  const {
    images,
    loading,
    nextCursor,
    loadMore,
    uploadPhoto,
    updatePhoto,
    cropPhoto,
    sharePhoto,
    selectImage,
    fetchPhotos,
    fetchImage,
  } = usePhotos();

  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showGoogleImport, setShowGoogleImport] = useState(false);
  // The viewer always shows the original image (parentId === ""), fetched on demand
  const [viewerImage, setViewerImage] = useState<AppImage | null>(null);

  const handleSelect = async (imageId: string) => {
    selectImage(imageId);
    const item = images.find((img) => img.id === imageId);
    if (!item) return;
    if (item.parentId !== "") {
      // It's a thumbnail — fetch the original by parentId
      const original = await fetchImage(item.parentId);
      setViewerImage(original);
    } else {
      // It's a fallback original (no thumbnail yet) — show it directly
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
      await uploadPhoto(file, file.name.replace(/\.[^.]+$/, ""), "");
    } finally {
      setUploading(false);
    }
  };

  const handleImportComplete = (_count: number) => {
    void fetchPhotos();
    setShowGoogleImport(false);
  };

  // Backfill thumbnails for orphan originals. A ref ensures each ID is only
  // submitted once per session — prevents loops when fetchPhotos refreshes state.
  const backfilledRef = useRef(new Set<string>());
  const orphanIds = images
    .filter((img) => img.parentId === "")
    .map((img) => img.id)
    .sort()
    .join(",");
  useEffect(() => {
    if (!orphanIds) return;
    const newIds = orphanIds.split(",").filter((id) => !backfilledRef.current.has(id));
    if (newIds.length === 0) return;
    newIds.forEach((id) => backfilledRef.current.add(id));
    newIds.forEach((id) => {
      fetch("/api/generate", {
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
          onUpdateCaption={async (caption) => {
            const updated = await updatePhoto(viewerImage.id, { caption });
            if (updated) setViewerImage(updated);
          }}
          onCrop={async (cropRect) => {
            const newImage = await cropPhoto(viewerImage.id, cropRect);
            if (newImage) {
              // newImage is the new original; update viewer to show it
              setViewerImage(newImage);
              selectImage(null);
            }
          }}
          onShare={async () => sharePhoto(viewerImage.id)}
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
