import React from "react";
import type { AppImage } from "@/photos-lib/client";
import { displayedAspect } from "@/photos-lib/render-geometry";
import { justifiedRows } from "./justified-layout";
import { PhotoThumbnail } from "./photo-thumbnail";

export const PHOTO_GAP = 4;

/**
 * The shape a record will be drawn in: its stored dimensions, swapped when EXIF
 * orientation rotates it a quarter turn, and a mild landscape guess when
 * nothing has read them.
 *
 * The rule moved into `@starkeep/photos-ladder` when the phone's grid became
 * justified rows too. Two surfaces that disagreed about a photograph's shape
 * would put it in differently sized boxes and therefore request different rungs
 * for the same picture — the layout and the sizing are one decision.
 */
export function displayAspect(image: AppImage): number {
  return displayedAspect({ width: image.width, height: image.height }, image.exif.orientation);
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
