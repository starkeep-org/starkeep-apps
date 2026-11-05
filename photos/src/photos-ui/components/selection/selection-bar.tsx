import React from "react";
import { buttonStyle, primaryButtonStyle } from "../albums/modal";

/**
 * The bar a selection raises at the foot of the screen: how many photos are
 * selected, and what can be done with them.
 */
export function SelectionBar({
  count,
  inAlbum,
  busy,
  onAddToAlbum,
  onRemoveFromAlbum,
  onSetCover,
  onShare,
  onClear,
}: {
  count: number;
  /** Inside an album, the bar offers removal and the cover. */
  inAlbum: boolean;
  busy: boolean;
  onAddToAlbum: () => void;
  onRemoveFromAlbum: () => void;
  onSetCover: () => void;
  onShare: () => void;
  onClear: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Selection"
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 200,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        padding: "10px 16px calc(10px + env(safe-area-inset-bottom))",
        background: "#1b1b1b",
        borderTop: "1px solid rgba(255,255,255,0.12)",
        color: "#eee",
        fontSize: 13,
      }}
    >
      <span style={{ marginRight: "auto", fontWeight: 600 }}>
        {count} selected
      </span>
      <button type="button" style={primaryButtonStyle} disabled={busy} onClick={onAddToAlbum}>
        Add to album…
      </button>
      {inAlbum ? (
        <>
          <button type="button" style={buttonStyle} disabled={busy} onClick={onRemoveFromAlbum}>
            Remove from album
          </button>
          {count === 1 ? (
            <button type="button" style={buttonStyle} disabled={busy} onClick={onSetCover}>
              Set as cover
            </button>
          ) : null}
        </>
      ) : (
        <button type="button" style={buttonStyle} disabled={busy} onClick={onShare}>
          Share link…
        </button>
      )}
      <button type="button" style={buttonStyle} disabled={busy} onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
