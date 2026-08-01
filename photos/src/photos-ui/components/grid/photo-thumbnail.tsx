import { useEffect, useState } from "react";
import type { AppImage } from "@/photos-lib";
import { variantSrc, tileTargetLongEdge } from "@/photos-lib";
import { usePhotoUrls } from "../../context/photo-url-context";
import { useInView } from "../../hooks/use-in-view";

const TILE_WIDTH = 180;

/**
 * Below this, serving a record's own bytes into a tile is not worth a round
 * trip through derivation. Above it, a record with no renditions shows its
 * placeholder instead — downloading 40 MB to fill a 180 px tile is the exact
 * cost the ladder exists to avoid, and doing it "just while derivation catches
 * up" is how a library becomes expensive on first load.
 */
const DIRECT_SERVE_MAX_BYTES = 512 * 1024;

function devicePixelRatioOf(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
}

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

  // Ask in pixels: tile size × device pixel ratio, because a 180 px tile on a
  // 3× phone is a 540 px image. The server already resolved which rendition
  // answers that; this is only the lookup.
  //
  // The old behaviour was to render *only records labelled as thumbnails* and
  // show a placeholder for everything else — so a library was a grid of
  // placeholders until derivation caught up, and originals were unclickable.
  // The grid now lists originals and displays a rendition of each.
  const target = tileTargetLongEdge(TILE_WIDTH, devicePixelRatioOf());
  const resolved = inView ? variantSrc(image, target) : null;

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

  return (
    <div
      ref={containerRef}
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
