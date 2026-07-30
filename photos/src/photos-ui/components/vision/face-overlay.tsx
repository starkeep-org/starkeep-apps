import { useEffect, useState } from "react";
import {
  fetchImageFaces,
  VISION_UNAVAILABLE,
  type DetectedFaceView,
  type ImageFaces,
} from "../../../lib/vision-client";
import { LabelledBoxOverlay } from "./labelled-box-overlay";

/**
 * Face boxes over the photo in the viewer.
 *
 * Only the fetching and the colour live here — the positioning, which is the part
 * that is subtle and identical for any task's boxes, moved to
 * `LabelledBoxOverlay` when objects arrived.
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
    <LabelledBoxOverlay
      testId="face-overlay"
      boxTestId="face-box"
      dimensions={dimensions}
      colour="rgba(120, 210, 255, 0.9)"
      labelColour="#cfefff"
      boxes={faces.map((face) => ({
        key: face.index,
        bbox: face.bbox,
        // Only *named* people are labelled: an unnamed cluster's id is not
        // something to put on a photo.
        label: face.name || undefined,
      }))}
    />
  );
}
