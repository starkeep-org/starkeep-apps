import { useEffect, useState } from "react";
import {
  fetchImageObjects,
  VISION_UNAVAILABLE,
  type DetectedObjectView,
  type ImageObjects,
} from "../../../lib/vision-client";
import { LabelledBoxOverlay } from "./labelled-box-overlay";

/**
 * Object boxes over the photo in the viewer.
 *
 * The same shape as `FaceOverlay`, sharing all the positioning through
 * `LabelledBoxOverlay` — which is what §9 meant by the overlay generalizing, and
 * why this file is short.
 *
 * A different colour on purpose: both overlays can be on at once, and a face box
 * and a "person" box will frequently sit almost on top of each other (the detector
 * finds the body, the face detector the head). Same colour would read as one
 * mis-drawn box.
 */

interface ObjectOverlayProps {
  recordId: string;
  visible: boolean;
  onLoaded?: (result: ImageObjects) => void;
}

export function ObjectOverlay({ recordId, visible, onLoaded }: ObjectOverlayProps) {
  const [objects, setObjects] = useState<DetectedObjectView[]>([]);
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setObjects([]);
    setDimensions(null);
    if (!visible) return;

    void (async () => {
      try {
        const result = await fetchImageObjects(recordId);
        if (cancelled || result === VISION_UNAVAILABLE) return;
        onLoaded?.(result);
        if (!result.processed || !result.width || !result.height) return;
        setDimensions({ w: result.width, h: result.height });
        setObjects(result.objects);
      } catch {
        // Decoration on top of the photo: a failed fetch shows no boxes rather
        // than an error over the image.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [recordId, visible, onLoaded]);

  if (!visible || !dimensions || objects.length === 0) return null;

  return (
    <LabelledBoxOverlay
      testId="object-overlay"
      boxTestId="object-box"
      dimensions={dimensions}
      colour="rgba(255, 190, 100, 0.9)"
      labelColour="#ffe6bf"
      boxes={objects.map((object) => ({
        key: object.index,
        bbox: object.bbox,
        // The score is on the label because an object label without it invites
        // "why does it think that is a cat" with no way to tell how sure it was.
        label: object.name ? `${object.name} ${Math.round(object.score * 100)}%` : undefined,
      }))}
    />
  );
}
