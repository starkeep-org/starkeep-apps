import React, { useEffect, useRef } from "react";
import type { AppImage } from "@/photos-lib/client";
import { DESKTOP_DEFAULT_ROW_HEIGHT } from "@/lib/list-layout-preferences";
import { useElementWidth } from "../../hooks/use-element-size";
import { DateSection } from "./date-section";
import { PhotoRows } from "./photo-rows";

interface PhotoGridProps {
  images: AppImage[];
  loading: boolean;
  hasMore: boolean;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
  /** Height every row is scaled to, in CSS pixels. */
  rowHeight?: number;
  /** Break the list into dated sections. Off by default: one flat list. */
  groupByDate?: boolean;
  /**
   * Drop the margin around the list so the photos run to the edges of the
   * screen. Wanted on a phone, where 16 px a side is a visible fraction of the
   * width and the frame it draws is worth less than the photo it costs.
   */
  edgeToEdge?: boolean;
}

export function PhotoGrid({
  images,
  loading,
  hasMore,
  onSelect,
  onLoadMore,
  // Callers normally pass the viewer's own preference, which is responsive to
  // the viewport; this is only what a caller that has no opinion gets.
  rowHeight = DESKTOP_DEFAULT_ROW_HEIGHT,
  groupByDate = false,
  edgeToEdge = false,
}: PhotoGridProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Measured on a padding-free element so the width the rows are justified to
  // is the width they are actually drawn in. Width only: this element is empty
  // until the rows it is being measured for are laid out, so waiting for a
  // positive height would wait forever.
  const [measureRef, containerWidth] = useElementWidth<HTMLDivElement>();

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          onLoadMore();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  // Group by date descending
  const grouped: Record<string, AppImage[]> = {};
  for (const img of images) {
    const day = img.effectiveDateTaken.slice(0, 10);
    (grouped[day] ??= []).push(img);
  }
  const sortedDays = Object.keys(grouped).sort().reverse();

  if (images.length === 0 && !loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "#666",
          fontSize: 16,
        }}
      >
        No photos yet. Upload some to get started.
      </div>
    );
  }

  return (
    <div style={{ paddingTop: edgeToEdge ? 0 : 16, paddingBottom: 32 }}>
      <div style={{ padding: edgeToEdge ? 0 : "0 16px" }}>
        <div ref={measureRef}>
          {groupByDate ? (
            sortedDays.map((day) => (
              <DateSection
                key={day}
                dateKey={day}
                images={grouped[day]}
                containerWidth={containerWidth}
                rowHeight={rowHeight}
                edgeToEdge={edgeToEdge}
                onSelect={onSelect}
              />
            ))
          ) : (
            <PhotoRows
              images={images}
              containerWidth={containerWidth}
              rowHeight={rowHeight}
              onSelect={onSelect}
            />
          )}
        </div>
      </div>
      <div ref={sentinelRef} style={{ height: 1 }} />
      {loading && (
        <div style={{ textAlign: "center", color: "#666", padding: 16 }}>Loading...</div>
      )}
    </div>
  );
}
