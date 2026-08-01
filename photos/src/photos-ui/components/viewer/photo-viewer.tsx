import { useCallback, useState, useEffect } from "react";
import type { AppImage } from "@/photos-lib";
import { isVideoRecord } from "@/photos-lib";
import { PhotoInfoPanel } from "./photo-info-panel";
import { VideoPlayer } from "./video-player";
import { usePhotoUrls } from "../../context/photo-url-context";
import { FaceOverlay } from "../vision/face-overlay";
import type { ImageFaces } from "../../../lib/vision-client";

// EXIF orientations 5–8 rotate the image by ±90°, so the *displayed* image
// swaps width and height relative to the stored (un-oriented) pixel
// dimensions. We use this to proportion the container to what's actually shown.
const ORIENTATION_SWAPS_AXES: Record<number, true> = { 5: true, 6: true, 7: true, 8: true };

interface PhotoViewerProps {
  image: AppImage;
  onClose: () => void;
}

export function PhotoViewer({ image, onClose }: PhotoViewerProps) {
  const { getFullSizeSrc } = usePhotoUrls();
  const [infoVisible, setInfoVisible] = useState(false);
  // Track whether the full-size image has actually finished downloading. Until
  // then we show a placeholder instead of a bare <img>, which would otherwise
  // render the browser's broken-image glyph while its signed URL is still being
  // fetched (a cache miss on open) and while the original downloads.
  const fullSizeSrc = getFullSizeSrc(image.id) ?? undefined;
  const isVideo = isVideoRecord(image);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
  }, [fullSizeSrc]);

  // Dimensions come with the record now (the list is fetched with
  // ?include=metadata), so the placeholder box is proportioned from real
  // width/height rather than a fixed rectangle. Null only when metadata hasn't
  // been extracted/backfilled yet — then we fall back to a neutral box.
  // Proportion the placeholder/box to the image as the browser will *display*
  // it. The browser auto-applies EXIF orientation (image-orientation defaults
  // to from-image), so for a rotated original the displayed width/height are
  // swapped relative to the stored pixel dimensions.
  const swapAxes = image.exif.orientation ? ORIENTATION_SWAPS_AXES[image.exif.orientation] ?? false : false;
  const displayWidth = swapAxes ? image.height : image.width;
  const displayHeight = swapAxes ? image.width : image.height;
  const ratio = displayWidth > 0 && displayHeight > 0 ? displayWidth / displayHeight : null;
  // The grid/sync-supplied `image` carries no enriched fields, so its caption is
  // always null here. The info panel resolves the assembled record and reports
  // the persisted caption (and later edits) up via onCaptionChange.
  const [caption, setCaption] = useState<string | null>(image.caption ?? null);

  useEffect(() => {
    setCaption(image.caption ?? null);
  }, [image.id, image.caption]);

  // Off by default — boxes over every photo would be a permanent overlay on a
  // photo viewer. `facesKnown` stays null until the overlay has actually asked,
  // so the toggle can say "no faces here" without claiming it before it knows.
  const [facesVisible, setFacesVisible] = useState(false);
  const [facesKnown, setFacesKnown] = useState<ImageFaces | null>(null);
  useEffect(() => {
    setFacesKnown(null);
  }, [image.id]);
  const onFacesLoaded = useCallback((result: ImageFaces) => setFacesKnown(result), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,1)",
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
          <button
            onClick={() => setFacesVisible((v) => !v)}
            title={
              facesKnown && !facesKnown.processed
                ? "This photo has not been scanned for faces yet"
                : "Show detected faces"
            }
            style={{
              background: facesVisible ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.2)",
              color: "#fff",
              borderRadius: 4,
              padding: "6px 14px",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Faces
            {facesVisible && facesKnown?.processed ? ` (${facesKnown.faces.length})` : ""}
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
        {/* One box holds both the skeleton and the image, sharing the exact same
            footprint so the photo never renders smaller than its loader. When
            dimensions are known the box is proportioned to the real aspect
            ratio; when they're not (metadata pending) the box keeps a fixed
            height and the image letterboxes into it. */}
        <div
          style={{
            position: "relative",
            ...(ratio
              ? {
                  width: `min(90vw, calc((100vh - 120px) * ${ratio}))`,
                  aspectRatio: ratio,
                  maxWidth: "90vw",
                  maxHeight: "calc(100vh - 120px)",
                }
              : {
                  width: "min(90vw, 900px)",
                  height: "calc(100vh - 120px)",
                }),
            overflow: "hidden",
          }}
        >
          {/* Video has no `onLoad`, so `loaded` never flips for it and the
              skeleton would pulse forever behind a playing clip. The player
              draws its own poster while it buffers. */}
          {!loaded && !isVideo && (
            <div
              aria-hidden
              data-testid="photo-skeleton"
              style={{
                position: "absolute",
                inset: 0,
                animation: "starkeep-skeleton-pulse 1.5s ease-in-out infinite",
              }}
            />
          )}
          {isVideo && <VideoPlayer image={image} onToggleInfo={() => setInfoVisible((v) => !v)} />}
          {!isVideo && fullSizeSrc && (
            <img
              src={fullSizeSrc}
              alt={image.originalFilename}
              onClick={() => setInfoVisible((v) => !v)}
              onLoad={() => setLoaded(true)}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "contain",
                // Let the browser apply EXIF orientation (this is the default,
                // but set explicitly so a global reset can't turn it off and
                // leave rotated originals sideways). We deliberately do NOT
                // also rotate via CSS transform, which would double-apply.
                imageOrientation: "from-image",
                opacity: loaded ? 1 : 0,
                transition: "opacity 0.3s ease",
                cursor: "pointer",
              }}
            />
          )}
          {/* Inside the same box the <img> fills, so bbox percentages land on
              the right pixels without measuring the rendered image. */}
          <FaceOverlay recordId={image.id} visible={facesVisible} onLoaded={onFacesLoaded} />
        </div>
        <style>{`@keyframes starkeep-skeleton-pulse { 0%, 100% { background-color: rgba(255, 255, 255, 0.07); } 50% { background-color: rgba(255, 255, 255, 0.16); } }`}</style>

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
