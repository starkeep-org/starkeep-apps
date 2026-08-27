import React from "react";
import type { AppImage } from "@/photos-lib/client";
import { PhotoRows } from "./photo-rows";

interface DateSectionProps {
  dateKey: string; // "YYYY-MM-DD"
  images: AppImage[];
  containerWidth: number | null;
  rowHeight: number;
  /** The photos run to the edge of the screen; the heading still should not. */
  edgeToEdge: boolean;
  onSelect: (id: string) => void;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export function DateSection({
  dateKey,
  images,
  containerWidth,
  rowHeight,
  edgeToEdge,
  onSelect,
}: DateSectionProps) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div
        style={{
          color: "#ccc",
          fontSize: 14,
          fontWeight: 600,
          marginBottom: 8,
          padding: edgeToEdge ? "0 12px" : 0,
        }}
      >
        {formatDate(dateKey)}
      </div>
      <PhotoRows
        images={images}
        containerWidth={containerWidth}
        rowHeight={rowHeight}
        onSelect={onSelect}
      />
    </div>
  );
}
