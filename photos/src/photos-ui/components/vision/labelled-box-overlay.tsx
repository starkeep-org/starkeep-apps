/**
 * Bounding boxes over the photo in the viewer, with optional labels.
 *
 * Extracted from `face-overlay.tsx` when objects arrived, which is the
 * generalization §9 predicted — the *positioning* is the hard part and it is
 * identical for any box a task produces, while the fetching and colouring are not.
 *
 * Positioned in **percentages of the sidecar's own dimensions**, not of the
 * record's stored width/height. The worker rotates by EXIF before inference, so a
 * sidecar's `w`/`h` are the displayed dimensions — which for an orientation-tagged
 * photo are the stored ones swapped. Scaling by the record's numbers would put
 * every box on a rotated photo in the wrong place, and would look right on the
 * majority of photos that carry no orientation tag.
 *
 * The overlay reproduces `objectFit: contain` in CSS — an inner box with the
 * sidecar's aspect ratio, capped at 100% of both axes and centred — so the boxes
 * track the rendered image at any window size without measuring it. That also
 * covers the case where the viewer has no dimensions yet and letterboxes the photo
 * into a fixed rectangle, which a plain `inset: 0` overlay would get wrong on
 * exactly the photos whose metadata has not arrived.
 */

export interface OverlayBox {
  /** Stable key within this overlay. */
  key: string | number;
  /** `[x, y, width, height]` in the sidecar's display-space pixels. */
  bbox: [number, number, number, number];
  /** Rendered above the box when present. */
  label?: string;
}

export interface LabelledBoxOverlayProps {
  boxes: readonly OverlayBox[];
  /** The sidecar's own display-space dimensions — see the module comment. */
  dimensions: { w: number; h: number };
  /** Border colour, so two overlays on one photo stay distinguishable. */
  colour: string;
  /** Label text colour. */
  labelColour: string;
  testId: string;
  boxTestId: string;
}

export function LabelledBoxOverlay({
  boxes,
  dimensions,
  colour,
  labelColour,
  testId,
  boxTestId,
}: LabelledBoxOverlayProps) {
  if (boxes.length === 0) return null;

  return (
    <div
      data-testid={testId}
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
        {boxes.map((box) => {
          const [x, y, w, h] = box.bbox;
          return (
            <div
              key={box.key}
              data-testid={boxTestId}
              style={{
                position: "absolute",
                left: `${(x / dimensions.w) * 100}%`,
                top: `${(y / dimensions.h) * 100}%`,
                width: `${(w / dimensions.w) * 100}%`,
                height: `${(h / dimensions.h) * 100}%`,
                border: `2px solid ${colour}`,
                borderRadius: 3,
                boxShadow: "0 0 0 1px rgba(0,0,0,0.5)",
              }}
            >
              {box.label && (
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    bottom: "100%",
                    marginBottom: 2,
                    padding: "1px 5px",
                    borderRadius: 3,
                    background: "rgba(0,0,0,0.75)",
                    color: labelColour,
                    fontSize: 11,
                    whiteSpace: "nowrap",
                  }}
                >
                  {box.label}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
