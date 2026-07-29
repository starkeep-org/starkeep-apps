import { useEffect, useState } from "react";
import {
  fetchImageFaces,
  VISION_UNAVAILABLE,
  type DetectedFaceView,
  type ImageFaces,
} from "../../../lib/vision-client";

/**
 * Bounding boxes over the photo in the viewer.
 *
 * Positioned in **percentages of the sidecar's own dimensions**, not of the
 * record's stored width/height. The worker rotates by EXIF before inference, so
 * a sidecar's `w`/`h` are the displayed dimensions — which for an
 * orientation-tagged photo are the stored ones swapped. Scaling by the record's
 * numbers would put every box on a rotated photo in the wrong place, and would
 * look right on the majority of photos that carry no orientation tag.
 *
 * The overlay reproduces `objectFit: contain` in CSS — an inner box with the
 * sidecar's aspect ratio, capped at 100% of both axes and centred — so the boxes
 * track the rendered image at any window size without measuring it. That also
 * covers the case where the viewer has no dimensions yet and letterboxes the
 * photo into a fixed rectangle, which a plain `inset: 0` overlay would get
 * wrong on exactly the photos whose metadata has not arrived.
 */

interface FaceOverlayProps {
  recordId: string;
  visible: boolean;
  onLoaded?: (result: ImageFaces) => void;
}

export function FaceOverlay({ recordId, visible, onLoaded }: FaceOverlayProps) {
  const [faces, setFaces] = useState<DetectedFaceView[]>([]);
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFaces([]);
    setDimensions(null);
    if (!visible) return;

    void (async () => {
      try {
        const result = await fetchImageFaces(recordId);
        if (cancelled || result === VISION_UNAVAILABLE) return;
        onLoaded?.(result);
        if (!result.processed || !result.width || !result.height) return;
        setDimensions({ w: result.width, h: result.height });
        setFaces(result.faces);
      } catch {
        // The overlay is decoration on top of the photo; a failed fetch shows
        // no boxes rather than an error over the image.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [recordId, visible, onLoaded]);

  if (!visible || !dimensions || faces.length === 0) return null;

  return (
    <div
      data-testid="face-overlay"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          position: "relative",
          aspectRatio: `${dimensions.w} / ${dimensions.h}`,
          maxWidth: "100%",
          maxHeight: "100%",
          width: "100%",
          height: "100%",
        }}
      >
        {faces.map((face) => {
          const [x, y, w, h] = face.bbox;
          return (
            <div
              key={face.index}
              data-testid="face-box"
              style={{
                position: "absolute",
                left: `${(x / dimensions.w) * 100}%`,
                top: `${(y / dimensions.h) * 100}%`,
                width: `${(w / dimensions.w) * 100}%`,
                height: `${(h / dimensions.h) * 100}%`,
                border: "2px solid rgba(120, 210, 255, 0.9)",
                borderRadius: 3,
                boxShadow: "0 0 0 1px rgba(0,0,0,0.5)",
              }}
            >
              {face.name && (
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    bottom: "100%",
                    marginBottom: 2,
                    padding: "1px 5px",
                    borderRadius: 3,
                    background: "rgba(0,0,0,0.75)",
                    color: "#cfefff",
                    fontSize: 11,
                    whiteSpace: "nowrap",
                  }}
                >
                  {face.name}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
