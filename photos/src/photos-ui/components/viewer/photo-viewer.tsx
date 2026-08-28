import { useCallback, useState, useEffect } from "react";
import type { AppImage } from "@/photos-lib/client";
import { displayForRenditionChoice, isVideoRecord } from "@/photos-lib/client";
import type { RenditionChoice } from "@/photos-lib/rendition-resolution";
import type { Dimensions } from "@/photos-lib/render-geometry";
import { canonicalMeasuredTarget, measuredPhysicalLongEdge } from "@/photos-lib/render-geometry";
import type { VideoDecision } from "@/lib/rendition-resolution-client";
import { PhotoInfoPanel } from "./photo-info-panel";
import { VideoPlayer } from "./video-player";
import { useMeasuredResolution, useRenditionPolicy } from "../../context/rendition-resolution-context";
import { useDevicePixelRatio, useViewportSize } from "../../hooks/use-element-size";
import { useNarrowViewport } from "../../../lib/use-narrow-viewport";
import { FaceOverlay } from "../vision/face-overlay";
import type { ImageFaces } from "../../../lib/vision-client";
import { requestDerivation } from "../../../lib/on-demand-derivation";

// EXIF orientations 5–8 rotate the image by ±90°, so the *displayed* image
// swaps width and height relative to the stored (un-oriented) pixel
// dimensions. We use this to proportion the container to what's actually shown.
const ORIENTATION_SWAPS_AXES: Record<number, true> = { 5: true, 6: true, 7: true, 8: true };

/**
 * Vertical room the viewer's chrome takes out of the viewport.
 *
 * Read by both the stage's CSS and {@link stageBox}, so the layout and the
 * rendition request cannot disagree about how much room the photo gets. A wrong
 * value here lays the photo out wrong as well as sizing it wrong, which is why
 * correcting the constant is the fix rather than measuring around it.
 */
const CHROME_ALLOWANCE_PX = 120;

/** Stage width as a fraction of the viewport. A phone has no width to spare. */
const STAGE_WIDTH_FRACTION = { narrow: 1, wide: 0.9 };

/** Stage width before the record's dimensions are known. */
const UNKNOWN_RATIO_MAX_WIDTH_PX = 900;

/**
 * The box the photo will occupy, in CSS pixels.
 *
 * Computed rather than observed. Every input is known before layout runs — the
 * viewport, which stage width applies, and the photo's displayed aspect ratio —
 * so a `ResizeObserver` here would only report a number this already has, one
 * frame and one debounce later. The grid makes the same call for the same
 * reason: its tiles take an assigned box rather than reading one back off the
 * DOM.
 *
 * Mirrors the stage's CSS exactly. `width` is `min(stage, availableHeight ×
 * ratio)` and `aspect-ratio` supplies the height, so a photo is bounded by
 * whichever of the two dimensions runs out first.
 */
function stageBox(
  viewport: Dimensions,
  widthFraction: number,
  ratio: number | null,
): Dimensions | null {
  const availableHeight = viewport.height - CHROME_ALLOWANCE_PX;
  const availableWidth = viewport.width * widthFraction;
  if (availableHeight <= 0 || availableWidth <= 0) return null;
  if (ratio === null) {
    return { width: Math.min(availableWidth, UNKNOWN_RATIO_MAX_WIDTH_PX), height: availableHeight };
  }
  const width = Math.min(availableWidth, availableHeight * ratio);
  return { width, height: width / ratio };
}

interface PhotoViewerProps {
  image: AppImage;
  onClose: () => void;
}

export function PhotoViewer({ image, onClose }: PhotoViewerProps) {
  const [infoVisible, setInfoVisible] = useState(false);
  // Track whether the full-size image has actually finished downloading. Until
  // then we show a placeholder instead of a bare <img>, which would otherwise
  // render the browser's broken-image glyph while its signed URL is still being
  // fetched (a cache miss on open) and while the original downloads.
  const isVideo = isVideoRecord(image);
  const kind = isVideo ? "video" : "still";
  const policy = useRenditionPolicy(kind);
  const devicePixelRatio = useDevicePixelRatio();
  const narrow = useNarrowViewport();
  const viewport = useViewportSize();
  // Side gutters are desktop framing. A phone has no width to spare, so the
  // photo gets the whole viewport and the target falls out of the larger box
  // rather than out of a 90% one.
  const widthFraction = narrow ? STAGE_WIDTH_FRACTION.narrow : STAGE_WIDTH_FRACTION.wide;
  const stageWidth = `${widthFraction * 100}vw`;
  // The photo is displayed with the browser's own EXIF rotation applied
  // (`image-orientation` defaults to `from-image`), so a rotated original shows
  // width and height swapped relative to its stored pixel dimensions. Both the
  // stage's shape and the rendition request follow the displayed dimensions.
  const swapAxes = image.exif.orientation ? ORIENTATION_SWAPS_AXES[image.exif.orientation] ?? false : false;
  const displayWidth = swapAxes ? image.height : image.width;
  const displayHeight = swapAxes ? image.width : image.height;
  const ratio = displayWidth > 0 && displayHeight > 0 ? displayWidth / displayHeight : null;
  const container = viewport ? stageBox(viewport, widthFraction, ratio) : null;
  const requiredLongEdge = container
    ? measuredPhysicalLongEdge({
        source: image.width > 0 && image.height > 0 ? { width: image.width, height: image.height } : null,
        container,
        orientation: image.exif.orientation,
        fit: "contain",
        devicePixelRatio,
      })
    : null;
  const viewportTarget = policy ? canonicalMeasuredTarget(policy, requiredLongEdge) : null;
  const resolution = useMeasuredResolution(image.id, kind, requiredLongEdge, viewportTarget);

  // The rendition, not the original.
  //
  // This used to resolve to the record's own bytes, and the viewport-sized
  // rendition the list query asks for specifically for this moment was never
  // read by anything. Measured on a real library that was 7.1 MB against
  // 0.55 MB — thirteen times the bytes, held open thirteen times as long, on
  // exactly the stream whose abort used to kill the data server.
  //
  // A record whose ladder has not been derived shows the skeleton and asks for
  // the rung it needs, rather than falling back to the original's own bytes.
  // The viewer used to reach that fallback through a second, client-side
  // sizing path — the same duplicate the grid carried — and the fallback it
  // guarded was already unreachable whenever a policy is published, which is
  // always. On-demand derivation is what answers an underived record now.
  const rendition = !isVideo && viewportTarget && resolution?.decision
    ? displayForRenditionChoice(resolution.decision as RenditionChoice, viewportTarget)
    : null;
  const pendingLongEdge = rendition?.awaitingBetter ? rendition.idealLongEdge : null;
  useEffect(() => {
    if (pendingLongEdge === null) return;
    requestDerivation(image.id, pendingLongEdge);
  }, [image.id, pendingLongEdge]);

  // When the decision's ideal and fallback are both absent, wait for the
  // requested rendition rather than silently downloading the original — a
  // measured 7.1 MB against 0.55 MB, held open thirteen times as long.
  const fullSizeSrc = rendition?.source?.url;
  useEffect(() => {
    console.log(
      `[photo-viewer] record=${image.id} target=${viewportTarget} ` +
        `source=${rendition?.source ? "rendition" : "pending"} ` +
        `ideal=${rendition?.idealLongEdge ?? "unknown"} state=${rendition?.state ?? "ready"}`,
    );
  }, [image.id, rendition?.idealLongEdge, rendition?.source, rendition?.state, viewportTarget]);
  const [displayedSrc, setDisplayedSrc] = useState<string | undefined>();
  useEffect(() => {
    setDisplayedSrc(undefined);
  }, [image.id]);
  const loaded = Boolean(displayedSrc);

  // Dimensions come with the record now (the list is fetched with
  // ?include=metadata), so the placeholder box is proportioned from real
  // width/height rather than a fixed rectangle. Null only when metadata hasn't
  // been extracted/backfilled yet — then we fall back to a neutral box.
  // Proportion the placeholder/box to the image as the browser will *display*
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
    setFacesVisible(false);
  }, [image.id]);
  const onFacesLoaded = useCallback((result: ImageFaces) => setFacesKnown(result), []);
  // A toggle for an overlay that would have nothing to draw is a control that
  // does nothing, and on a phone it is the control that costs the close button
  // its place on the line. The overlay reports what it found for every record
  // it opens, so the button appears only once there is something to show.
  const hasFaces = Boolean(facesKnown?.processed && facesKnown.faces.length > 0);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const toggleStyle = (active: boolean): React.CSSProperties => ({
    background: active ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.1)",
    border: "1px solid rgba(255,255,255,0.2)",
    color: "#fff",
    borderRadius: 4,
    padding: "6px 14px",
    cursor: "pointer",
    fontSize: 13,
    flexShrink: 0,
  });
  const toggles = (
    <>
      <button onClick={() => setInfoVisible(!infoVisible)} style={toggleStyle(infoVisible)}>
        Info
      </button>
      {hasFaces && (
        <button
          onClick={() => setFacesVisible((v) => !v)}
          title="Show detected faces"
          style={toggleStyle(facesVisible)}
        >
          Faces{facesVisible ? ` (${facesKnown!.faces.length})` : ""}
        </button>
      )}
    </>
  );

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
      {/* The close button never leaves the first line. A phone-width header has
          no room for the filename and both toggles beside it, and the control
          that got pushed off the edge was the only way out of the viewer, so
          the toggles wrap to a line of their own instead. */}
      <div style={{ display: "flex", flexDirection: "column", gap: narrow ? 8 : 0, padding: "12px 16px", flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <span
              style={{
                color: "#aaa",
                fontSize: 14,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {image.originalFilename}
            </span>
            {!narrow && toggles}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: "none", border: "none", color: "#fff", fontSize: 24, cursor: "pointer", lineHeight: 1, padding: "0 4px", flexShrink: 0 }}
          >
            ×
          </button>
        </div>
        {narrow && <div style={{ display: "flex", alignItems: "center", gap: 12 }}>{toggles}</div>}
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
                  width: `min(${stageWidth}, calc((100vh - ${CHROME_ALLOWANCE_PX}px) * ${ratio}))`,
                  aspectRatio: ratio,
                  maxWidth: stageWidth,
                  maxHeight: `calc(100vh - ${CHROME_ALLOWANCE_PX}px)`,
                }
              : {
                  width: `min(${stageWidth}, ${UNKNOWN_RATIO_MAX_WIDTH_PX}px)`,
                  height: `calc(100vh - ${CHROME_ALLOWANCE_PX}px)`,
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
          {isVideo && viewportTarget && (
            <VideoPlayer
              image={image}
              targetLongEdge={viewportTarget}
              decision={resolution?.decision as VideoDecision | undefined}
              onToggleInfo={() => setInfoVisible((v) => !v)}
            />
          )}
          {!isVideo && displayedSrc && displayedSrc !== fullSizeSrc && (
            <img
              src={displayedSrc}
              alt={image.originalFilename}
              onClick={() => setInfoVisible((v) => !v)}
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
                opacity: 1,
                transition: "opacity 0.3s ease",
                cursor: "pointer",
              }}
            />
          )}
          {!isVideo && fullSizeSrc && (
            <img
              key="candidate"
              src={fullSizeSrc}
              alt={displayedSrc && displayedSrc !== fullSizeSrc ? "" : image.originalFilename}
              aria-hidden={displayedSrc && displayedSrc !== fullSizeSrc ? true : undefined}
              onLoad={() => setDisplayedSrc(fullSizeSrc)}
              style={displayedSrc && displayedSrc !== fullSizeSrc
                ? { position: "absolute", width: 1, height: 1, opacity: 0 }
                : {
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    imageOrientation: "from-image",
                    opacity: displayedSrc === fullSizeSrc ? 1 : 0,
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
          <div style={{ color: "#ddd", fontSize: 14, marginTop: 16, maxWidth: stageWidth, textAlign: "center", padding: "0 16px" }}>
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
