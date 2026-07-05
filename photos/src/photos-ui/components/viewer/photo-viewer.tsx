import { useState, useEffect } from "react";
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
  // Track whether the full-size image has actually finished downloading. Until
  // then we show a skeleton instead of a bare <img>, which would otherwise
  // render the browser's broken-image glyph while its signed URL is still being
  // fetched (a cache miss on open) and while the original downloads.
  const fullSizeSrc = getFullSizeSrc(image.id) ?? undefined;
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
  }, [fullSizeSrc]);
  // The grid/sync-supplied `image` carries no enriched fields, so its caption is
  // always null here. The info panel resolves the assembled record and reports
  // the persisted caption (and later edits) up via onCaptionChange.
  const [caption, setCaption] = useState<string | null>(image.caption ?? null);

  useEffect(() => {
    setCaption(image.caption ?? null);
  }, [image.id, image.caption]);

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

      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden" }}>
        {!loaded && (
          <div
            aria-hidden
            data-testid="photo-skeleton"
            style={{
              width: "min(90vw, 900px)",
              height: "calc(100vh - 200px)",
              borderRadius: 8,
              background:
                "linear-gradient(100deg, rgba(255,255,255,0.04) 30%, rgba(255,255,255,0.10) 50%, rgba(255,255,255,0.04) 70%)",
              backgroundSize: "200% 100%",
              animation: "starkeep-skeleton-shimmer 1.4s ease-in-out infinite",
            }}
          />
        )}
        {fullSizeSrc && (
          <img
            src={fullSizeSrc}
            alt={image.originalFilename}
            onClick={() => setInfoVisible((v) => !v)}
            onLoad={() => setLoaded(true)}
            style={{
              maxWidth: "90vw",
              maxHeight: "calc(100vh - 200px)",
              objectFit: "contain",
              transform,
              display: loaded ? "block" : "none",
              cursor: "pointer",
            }}
          />
        )}
        <style>{`@keyframes starkeep-skeleton-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>

        {caption && (
          <div style={{ color: "#ddd", fontSize: 14, marginTop: 16, maxWidth: "90vw", textAlign: "center", padding: "0 16px" }}>
            {caption}
          </div>
        )}

        <PhotoInfoPanel
          image={image}
          visible={infoVisible}
          onClose={() => setInfoVisible(false)}
          onCaptionChange={setCaption}
        />
      </div>
    </div>
  );
}
