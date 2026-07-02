import { useEffect, useState } from "react";
import type { AppImage } from "@/photos-lib";
import { withBasePath } from "@/lib/base-path";
import { backfillImageMetadata } from "@/lib/data-server-client";
import { formatBytes, formatMegapixels, formatOrientation } from "./info-format";

interface InfoRowProps {
  label: string;
  value: string | number;
}

function InfoRow({ label, value }: InfoRowProps) {
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
      <span style={{ color: "#888", fontSize: 12, minWidth: 100, flexShrink: 0 }}>{label}</span>
      <span style={{ color: "#ddd", fontSize: 12 }}>{String(value)}</span>
    </div>
  );
}

interface PhotoInfoPanelProps {
  image: AppImage;
  visible: boolean;
  onClose: () => void;
  /** Fires with the persisted caption on load and after each save, so callers
   *  (e.g. the viewer's below-image caption) can stay in sync with edits. */
  onCaptionChange?: (caption: string | null) => void;
}

export function PhotoInfoPanel({ image, visible, onClose, onCaptionChange }: PhotoInfoPanelProps) {
  const [caption, setCaption] = useState<string>("");
  const [savedCaption, setSavedCaption] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  // The image passed in from the list carries no dimensions/EXIF (that metadata
  // isn't loaded for the whole grid). Fetch the fully-assembled record — record
  // + shared image metadata + enriched fields — when the panel opens, and
  // render from it once it arrives, falling back to the sparse prop meanwhile.
  const [details, setDetails] = useState<AppImage | null>(null);
  const [detailsLoaded, setDetailsLoaded] = useState<boolean>(false);

  function fetchDetails(id: string): Promise<AppImage | null> {
    return fetch(withBasePath(`/api/photos/${encodeURIComponent(id)}`))
      .then((r) => (r.ok ? r.json() : { image: null }))
      .then((data: { image: AppImage | null }) => data.image);
  }

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setDetailsLoaded(false);
    setLoading(true);
    fetchDetails(image.id)
      .then((img) => {
        if (cancelled) return;
        if (img) {
          setDetails(img);
          // The assembled record already carries the enriched caption, so seed
          // the editor from it rather than making a second round trip.
          const existing = img.caption ?? "";
          setCaption(existing);
          setSavedCaption(existing);
          onCaptionChange?.(img.caption ?? null);
        }
        setLoading(false);
        setDetailsLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          setDetailsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [image.id]);

  // If the stored metadata resolved with no dimensions, the record was added by
  // a path that doesn't extract metadata (e.g. the LDS folder watcher). Extract
  // and persist it in the background, then re-load so the panel reflects the
  // now-stored dimensions + EXIF. Runs in parallel with the open above.
  const storedWidth = details?.width ?? image.width;
  useEffect(() => {
    if (!detailsLoaded || storedWidth > 0) return;
    let cancelled = false;
    backfillImageMetadata(image.id, (details ?? image).mimeType)
      .then((wrote) => (wrote && !cancelled ? fetchDetails(image.id) : null))
      .then((img) => {
        if (!cancelled && img) setDetails(img);
      })
      .catch(() => {
        /* best-effort: leave the panel as-is if extraction/write fails */
      });
    return () => {
      cancelled = true;
    };
    // details is intentionally excluded: this should fire once per record, keyed
    // on the resolved-but-empty state, not on every details update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image.id, detailsLoaded, storedWidth]);

  async function saveCaption(): Promise<void> {
    if (caption === savedCaption) return;
    await fetch(withBasePath(`/api/photos/captions/${encodeURIComponent(image.id)}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caption }),
    });
    setSavedCaption(caption);
    onCaptionChange?.(caption === "" ? null : caption);
  }

  // Prefer the fully-assembled record once loaded; the prop is a sparse
  // placeholder whose dimensions/EXIF are zeroed out.
  const info = details ?? image;
  const megapixels = formatMegapixels(info.width, info.height);

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 280,
        background: "rgba(20,20,20,0.95)",
        borderLeft: "1px solid rgba(255,255,255,0.1)",
        overflowY: "auto",
        padding: 16,
        transform: visible ? "translateX(0)" : "translateX(100%)",
        transition: "transform 0.2s ease",
        zIndex: 10,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <span style={{ color: "#fff", fontWeight: 600, fontSize: 14 }}>Photo Info</span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "#888",
            cursor: "pointer",
            fontSize: 18,
            padding: 0,
          }}
        >
          ×
        </button>
      </div>

      <InfoRow label="Filename" value={info.originalFilename} />
      {info.title && <InfoRow label="Title" value={info.title} />}
      <InfoRow label="Dimensions" value={`${info.width} × ${info.height}px`} />
      {megapixels && <InfoRow label="Megapixels" value={megapixels} />}
      <InfoRow label="MIME type" value={info.mimeType} />
      <InfoRow label="File size" value={formatBytes(info.sizeBytes)} />
      <InfoRow label="Date taken" value={info.effectiveDateTaken.replace("T", " ").slice(0, 19)} />

      {info.exif.cameraMake && (
        <InfoRow label="Camera" value={`${info.exif.cameraMake} ${info.exif.cameraModel ?? ""}`.trim()} />
      )}
      {info.exif.fNumber != null && (
        <InfoRow label="Aperture" value={`f/${info.exif.fNumber}`} />
      )}
      {info.exif.exposureTime && (
        <InfoRow label="Exposure" value={info.exif.exposureTime} />
      )}
      {info.exif.iso != null && (
        <InfoRow label="ISO" value={info.exif.iso} />
      )}
      {info.exif.lensModel && (
        <InfoRow label="Lens" value={info.exif.lensModel} />
      )}
      {info.exif.orientation != null && (
        <InfoRow label="Orientation" value={formatOrientation(info.exif.orientation)} />
      )}
      {info.exif.gpsLat != null && info.exif.gpsLon != null && (
        <InfoRow
          label="Location"
          value={`${info.exif.gpsLat.toFixed(5)}, ${info.exif.gpsLon.toFixed(5)}`}
        />
      )}

      <div style={{ marginTop: 20 }}>
        <div style={{ color: "#888", fontSize: 12, marginBottom: 6 }}>Caption</div>
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          onBlur={saveCaption}
          disabled={loading}
          placeholder={loading ? "Loading…" : "Add a caption…"}
          style={{
            width: "100%",
            minHeight: 70,
            boxSizing: "border-box",
            background: "rgba(0,0,0,0.4)",
            color: "#ddd",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 4,
            padding: 8,
            fontSize: 12,
            fontFamily: "inherit",
            resize: "vertical",
          }}
        />
      </div>
    </div>
  );
}
