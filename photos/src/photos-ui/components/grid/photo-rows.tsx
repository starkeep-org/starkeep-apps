import React from "react";
import type { AppImage } from "@/photos-lib/client";
import { displayedDimensions } from "@/photos-lib/render-geometry";
import { justifiedRows } from "./justified-layout";
import { PhotoThumbnail } from "./photo-thumbnail";

export const PHOTO_GAP = 4;

/**
 * The shape a record will be drawn in: its stored dimensions, swapped when EXIF
 * orientation rotates it a quarter turn. A record whose dimensions were never
 * read gets a mild landscape guess, which is wrong in the least disruptive way
 * available — it is a row-width estimate, not a crop.
 */
const UNKNOWN_ASPECT = 1.5;

export function displayAspect(image: AppImage): number {
  if (!(image.width > 0 && image.height > 0)) return UNKNOWN_ASPECT;
  const displayed = displayedDimensions({ width: image.width, height: image.height }, image.exif.orientation);
  return displayed.width / displayed.height;
}

interface PhotoRowsProps {
  images: AppImage[];
  /** Content width to fill, in CSS pixels; null until the container is measured. */
  containerWidth: number | null;
  rowHeight: number;
  onSelect: (id: string) => void;
}

export function PhotoRows({ images, containerWidth, rowHeight, onSelect }: PhotoRowsProps) {
  // Nothing is drawn before the container has been measured: a first paint at a
  // guessed width would lay every row out twice, and the second layout is the
  // one that moves photos out from under the pointer.
  if (containerWidth === null) return null;

  const rows = justifiedRows(images, displayAspect, {
    containerWidth,
    targetRowHeight: rowHeight,
    gap: PHOTO_GAP,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: PHOTO_GAP }}>
      {rows.map((row) => (
        <div
          key={row.placements[0].item.id}
          style={{ display: "flex", gap: PHOTO_GAP, height: row.height }}
        >
          {row.placements.map(({ item, width }) => (
            <PhotoThumbnail
              key={item.id}
              image={item}
              width={width}
              height={row.height}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
