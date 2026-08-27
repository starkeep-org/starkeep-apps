import React, { useEffect, useRef, useState } from "react";
import { CoverImageControls } from "./CoverImage";
import {
  ROW_HEIGHT_MAX,
  ROW_HEIGHT_MIN,
  ROW_HEIGHT_STEP,
  type ListLayoutPreferences,
} from "./list-layout-preferences";

/**
 * Everything about Photos that is not "look at photos" or "add a photo".
 *
 * It exists because a phone-width header cannot hold the display controls, the
 * cover-image buttons and the face-recognition entry point beside the app name
 * and the add button — and because a header that only just fits on a desktop is
 * a header that will stop fitting the next time something is added to it. One
 * menu at every width keeps the header to three things and gives each of these
 * a place to grow into.
 */
interface SettingsMenuProps {
  layout: ListLayoutPreferences;
  onLayoutChange: (patch: Partial<ListLayoutPreferences>) => void;
  /** Cloud target only: opens the cloud connection panel. */
  onOpenCloudSetup: (() => void) | null;
  /** Local target only: opens on-device face recognition. */
  onOpenFaces: (() => void) | null;
}

export function SettingsMenu({
  layout,
  onLayoutChange,
  onOpenCloudSetup,
  onOpenFaces,
}: SettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Dismissal is deliberately broad — a click anywhere else, or Escape —
  // because the menu covers content and a viewer who has finished with it
  // should not have to find the gear again to get rid of it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-label="Settings"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Settings"
        style={{
          background: open ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.08)",
          border: "1px solid rgba(255,255,255,0.15)",
          color: "#ddd",
          borderRadius: 4,
          padding: "6px 12px",
          cursor: "pointer",
          fontSize: 14,
          lineHeight: 1.2,
        }}
      >
        ⚙
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Settings"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            // Narrower than the phone screens it has to fit on, so it never
            // pushes its own edge off the side of the viewport.
            width: "min(280px, calc(100vw - 24px))",
            background: "#1b1b1b",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 6,
            boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 16,
            zIndex: 200,
          }}
        >
          <Section title="Display">
            <label style={rowStyle}>
              <span style={{ color: "#bbb", fontSize: 13 }}>Row height</span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="range"
                  min={ROW_HEIGHT_MIN}
                  max={ROW_HEIGHT_MAX}
                  step={ROW_HEIGHT_STEP}
                  value={layout.rowHeight}
                  onChange={(e) => onLayoutChange({ rowHeight: Number(e.target.value) })}
                  style={{ width: 120, accentColor: "#888" }}
                />
                <span style={{ color: "#777", fontSize: 12, minWidth: 38, textAlign: "right" }}>
                  {layout.rowHeight}px
                </span>
              </span>
            </label>

            <label style={{ ...rowStyle, cursor: "pointer" }}>
              <span style={{ color: "#bbb", fontSize: 13 }}>Date headings</span>
              <input
                type="checkbox"
                checked={layout.groupByDate}
                onChange={(e) => onLayoutChange({ groupByDate: e.target.checked })}
                style={{ accentColor: "#888" }}
              />
            </label>
          </Section>

          <Section title="Cover image">
            <CoverImageControls />
          </Section>

          {(onOpenFaces || onOpenCloudSetup) && (
            <Section title="Library">
              {onOpenFaces && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onOpenFaces();
                  }}
                  style={menuButtonStyle}
                >
                  On-device face recognition
                </button>
              )}
              {onOpenCloudSetup && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onOpenCloudSetup();
                  }}
                  style={menuButtonStyle}
                >
                  Cloud setup
                </button>
              )}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          color: "#777",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
};

const menuButtonStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#ddd",
  borderRadius: 4,
  padding: "8px 12px",
  cursor: "pointer",
  fontSize: 13,
  textAlign: "left",
};
