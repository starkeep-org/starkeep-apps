import { useEffect, useState } from "react";
import type { AppImage } from "@/photos-lib/client";
import { displayForRenditionChoice, isVideoRecord, posterSrc, stillDisplay, tileTargetLongEdge } from "@/photos-lib/client";
import type { RenditionChoice } from "@/photos-lib/rendition-resolution";
import { canonicalMeasuredTarget, measuredPhysicalLongEdge } from "@/photos-lib/render-geometry";
import type { VideoDecision } from "@/lib/rendition-resolution-client";
import { requestDerivation } from "@/lib/on-demand-derivation";
import { usePhotoUrls } from "../../context/photo-url-context";
import { useMeasuredResolution, useRenditionPolicy } from "../../context/rendition-resolution-context";
import { useInView } from "../../hooks/use-in-view";
import { useDevicePixelRatio, useElementSize } from "../../hooks/use-element-size";

const TILE_WIDTH = 180;

/**
 * Below this, serving a record's own bytes into a tile is not worth a round
 * trip through derivation. Above it, a record with no renditions shows its
 * placeholder instead — downloading 40 MB to fill a 180 px tile is the exact
 * cost the ladder exists to avoid, and doing it "just while derivation catches
 * up" is how a library becomes expensive on first load.
 */
const DIRECT_SERVE_MAX_BYTES = 512 * 1024;

/**
 * Decode a base64 ThumbHash into a data URL, once per hash.
 *
 * Decoded lazily and client-side: the hash rides the record (zero requests),
 * and turning it into pixels is cheap enough to do per tile but not free
 * enough to redo on every render.
 */
function usePlaceholderDataUrl(thumbHash: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!thumbHash) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { thumbHashToDataURL } = await import("thumbhash");
        const bytes = Uint8Array.from(atob(thumbHash), (c) => c.charCodeAt(0));
        if (!cancelled) setUrl(thumbHashToDataURL(bytes));
      } catch {
        // A placeholder that fails to decode is a plain tile, not an error.
        if (!cancelled) setUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [thumbHash]);
  return url;
}

interface PhotoThumbnailProps {
  image: AppImage;
  onSelect: (id: string) => void;
}

export function PhotoThumbnail({ image, onSelect }: PhotoThumbnailProps) {
  const { getFullSizeSrc } = usePhotoUrls();
  // Only ask for bytes once the tile is near the viewport, so a large gallery
  // doesn't fan out into a request per photo on load.
  const [containerRef, inView] = useInView<HTMLDivElement>();
  const [sizeRef, containerSize] = useElementSize<HTMLDivElement>();
  const video = isVideoRecord(image);
  const kind = video ? "video" : "still";
  const policy = useRenditionPolicy(kind);
  const devicePixelRatio = useDevicePixelRatio();
  const requiredLongEdge = inView && containerSize
    ? measuredPhysicalLongEdge({
        source: image.width > 0 && image.height > 0 ? { width: image.width, height: image.height } : null,
        container: containerSize,
        orientation: image.exif.orientation,
        fit: "cover",
        devicePixelRatio,
      })
    : null;
  const target = policy ? canonicalMeasuredTarget(policy, requiredLongEdge) : null;
  const resolution = useMeasuredResolution(image.id, kind, requiredLongEdge, target);

  // Ask in pixels: tile size × device pixel ratio, because a 180 px tile on a
  // 3× phone is a 540 px image. The server already resolved which rendition
  // answers that; this is only the lookup.
  //
  // The old behaviour was to render *only records labelled as thumbnails* and
  // show a placeholder for everything else — so a library was a grid of
  // placeholders until derivation caught up, and originals were unclickable.
  // The grid now lists originals and displays a rendition of each.
  // Two answers, because a still and a video are asking different questions. A
  // still gets the ideal-and-fallback shape the app server resolved against the
  // ladder; a video's children include a poster and a transcode at the same long
  // edge, so it keeps the type-filtered resolution that can tell them apart.
  const legacyTarget = tileTargetLongEdge(
    TILE_WIDTH,
    devicePixelRatio,
  );
  const display = !video
    ? target && resolution?.decision
      ? displayForRenditionChoice(resolution.decision as RenditionChoice, target)
      : !policy && inView
        ? stillDisplay(image, legacyTarget)
        : null
    : null;
  const poster = video ? (resolution?.decision as VideoDecision | undefined)?.poster : undefined;
  const resolved = display?.source ?? (poster?.url
    ? {
        url: poster.url,
        width: poster.width,
        height: poster.height,
        isBelowTarget: target ? Math.max(poster.width, poster.height) < target : false,
      }
    : !policy && inView && video ? posterSrc(image, legacyTarget) : null);

  // The tile has been told the rung it wants is missing, that it is derivable,
  // and how big it is — so this is a specific request rather than a guess from
  // an absence. Only for what is on screen, and only once per record per
  // session; the scheduler owns the rest, including the bound.
  const pendingLongEdge = display?.awaitingBetter ? display.idealLongEdge : null;
  useEffect(() => {
    if (pendingLongEdge === null) return;
    requestDerivation(image.id, pendingLongEdge);
  }, [image.id, pendingLongEdge]);

  // Fall back to the record's own bytes only when it has no renditions at all
  // *and* is small enough that serving it directly is not absurd. A record
  // mid-derivation shows its placeholder rather than a full-size original —
  // downloading 40 MB to fill a 180 px tile is the exact cost the ladder
  // exists to avoid.
  const fallbackSrc =
    resolved === null && inView && image.sizeBytes <= DIRECT_SERVE_MAX_BYTES
      ? getFullSizeSrc(image.id)
      : null;

  const src = resolved?.url ?? fallbackSrc;
  const placeholder = usePlaceholderDataUrl(image.thumbHash);

  // The one state a user should be told about. Everything else that is missing
  // is missing *for now* and says nothing, because there is nothing to do about
  // it; this one is a photo in a format the node answering cannot read, which
  // is temporary and self-healing and looks exactly like a bug if left silent.
  const undecodable = display?.state === "undecodable-here" && src === null;

  return (
    <div
      ref={(element) => {
        containerRef.current = element;
        sizeRef(element);
      }}
      onClick={() => onSelect(image.id)}
      style={{
        width: TILE_WIDTH,
        height: 120,
        overflow: "hidden",
        cursor: "pointer",
        borderRadius: 4,
        background: "#222",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {src ? (
        <img
          src={src}
          alt={image.originalFilename}
          loading="lazy"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            // Let the browser apply EXIF orientation (the default; set
            // explicitly so a global reset can't leave a rotated image
            // sideways). Never also rotate via CSS transform — that would
            // double-apply the rotation. Normalized thumbnails carry no
            // orientation anyway, so this is a defensive no-op for them.
            imageOrientation: "from-image",
          }}
        />
      ) : undecodable ? (
        <UndisplayableTile />
      ) : placeholder ? (
        // Stage zero: the inline ThumbHash, painted with zero requests. This is
        // what a record looks like before any image bytes are fetched — and
        // what it keeps looking like if its renditions never arrive.
        <img
          src={placeholder}
          alt=""
          aria-hidden
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: "repeating-linear-gradient(45deg, #1a1a1a, #1a1a1a 4px, #222 4px, #222 8px)",
          }}
        />
      )}
    </div>
  );
}

/**
 * What a record shows when the node that would derive its renditions cannot
 * read its format.
 *
 * Since the inline placeholder is itself derived, such a record has nothing to
 * paint at all — so without this it is an indefinitely grey tile, which is
 * indistinguishable from a broken app. The label and the explainer exist to say
 * the opposite of what the grey box says: the photo is intact, and this fixes
 * itself as soon as a node that can read the format sees it.
 */
function UndisplayableTile() {
  const [showExplainer, setShowExplainer] = useState(false);
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        padding: 8,
        textAlign: "center",
        color: "#999",
        fontSize: 11,
        background: "#1a1a1a",
      }}
    >
      <span>Cannot be displayed</span>
      <button
        type="button"
        aria-label="Why can this photo not be displayed?"
        onClick={(e) => {
          e.stopPropagation();
          setShowExplainer(true);
        }}
        style={{
          background: "none",
          border: "1px solid #444",
          borderRadius: "50%",
          color: "#999",
          cursor: "pointer",
          width: 18,
          height: 18,
          lineHeight: "16px",
          padding: 0,
          fontSize: 11,
        }}
      >
        i
      </button>
      {showExplainer ? (
        <div
          role="dialog"
          aria-label="Why this photo cannot be displayed"
          onClick={(e) => {
            e.stopPropagation();
            setShowExplainer(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div
            style={{
              maxWidth: 380,
              background: "#181818",
              border: "1px solid #333",
              borderRadius: 8,
              padding: 20,
              color: "#ddd",
              fontSize: 13,
              lineHeight: 1.5,
              textAlign: "left",
            }}
          >
            <p style={{ marginTop: 0 }}>
              This photo is stored in a format this server cannot read, so the
              smaller sizes the grid needs have not been made yet.
            </p>
            <p>
              The photo itself is safe and unmodified. Opening Photos on the
              machine that holds it, or on the mobile app, will produce the
              missing sizes and fix this automatically.
            </p>
            <p style={{ marginBottom: 0, color: "#888" }}>Tap anywhere to close.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
