import { useEffect, useState } from "react";
import type { AppImage } from "@/photos-lib";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
}

export function PhotoInfoPanel({ image, visible, onClose }: PhotoInfoPanelProps) {
  const [caption, setCaption] = useState<string>("");
  const [savedCaption, setSavedCaption] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/photos/captions/${encodeURIComponent(image.id)}`)
      .then((r) => (r.ok ? r.json() : { caption: null }))
      .then((data: { caption: string | null }) => {
        if (cancelled) return;
        const existing = data.caption ?? "";
        setCaption(existing);
        setSavedCaption(existing);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [image.id]);

  async function saveCaption(): Promise<void> {
    if (caption === savedCaption) return;
    await fetch(`/api/photos/captions/${encodeURIComponent(image.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caption }),
    });
    setSavedCaption(caption);
  }

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

      <InfoRow label="Filename" value={image.originalFilename} />
      <InfoRow label="Dimensions" value={`${image.width} × ${image.height}px`} />
      <InfoRow label="MIME type" value={image.mimeType} />
      <InfoRow label="File size" value={formatBytes(image.sizeBytes)} />
      <InfoRow label="Date taken" value={image.effectiveDateTaken.replace("T", " ").slice(0, 19)} />

      {image.exif.cameraMake && (
        <InfoRow label="Camera" value={`${image.exif.cameraMake} ${image.exif.cameraModel ?? ""}`.trim()} />
      )}
      {image.exif.fNumber != null && (
        <InfoRow label="Aperture" value={`f/${image.exif.fNumber}`} />
      )}
      {image.exif.exposureTime && (
        <InfoRow label="Exposure" value={image.exif.exposureTime} />
      )}
      {image.exif.iso != null && (
        <InfoRow label="ISO" value={image.exif.iso} />
      )}
      {image.exif.lensModel && (
        <InfoRow label="Lens" value={image.exif.lensModel} />
      )}
      {image.exif.gpsLat != null && image.exif.gpsLon != null && (
        <InfoRow
          label="Location"
          value={`${image.exif.gpsLat.toFixed(5)}, ${image.exif.gpsLon.toFixed(5)}`}
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
