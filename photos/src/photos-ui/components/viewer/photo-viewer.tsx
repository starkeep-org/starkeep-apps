import React, { useState, useEffect } from "react";
import type { AppImage } from "@/photos-lib";
import { PhotoInfoPanel } from "./photo-info-panel";
import { usePhotoUrls } from "../../context/photo-url-context";

const ORIENTATION_TRANSFORMS: Record<number, string> = {
  3: "rotate(180deg)",
  6: "rotate(90deg)",
  8: "rotate(270deg)",
};

interface PhotoViewerProps {
  image: AppImage;
  onClose: () => void;
}

export function PhotoViewer({ image, onClose }: PhotoViewerProps) {
  const { getFullSizeSrc } = usePhotoUrls();
  const [infoVisible, setInfoVisible] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const transform = image.exif.orientation
    ? ORIENTATION_TRANSFORMS[image.exif.orientation] ?? "none"
    : "none";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.92)",
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "#aaa", fontSize: 14 }}>{image.originalFilename}</span>
          <button
            onClick={() => setInfoVisible(!infoVisible)}
            style={{
              background: infoVisible ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.2)",
              color: "#fff",
              borderRadius: 4,
              padding: "6px 14px",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Info
          </button>
        </div>
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", color: "#fff", fontSize: 24, cursor: "pointer", lineHeight: 1, padding: "0 4px" }}
        >
          ×
        </button>
      </div>

      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden" }}>
        <img
          src={getFullSizeSrc(image.id) ?? undefined}
          alt={image.originalFilename}
          style={{ maxWidth: "90vw", maxHeight: "calc(100vh - 200px)", objectFit: "contain", transform, display: "block" }}
        />

        <PhotoInfoPanel image={image} visible={infoVisible} onClose={() => setInfoVisible(false)} />
      </div>
    </div>
  );
}
