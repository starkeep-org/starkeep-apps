import React, { useState } from "react";
import { ALBUM_TITLE_MAX, normalizeAlbumTitle, type Album } from "@/photos-lib/client";
import { Modal, buttonStyle, inputStyle, primaryButtonStyle } from "./modal";

/**
 * Choose an album for the selection, or name a new one.
 *
 * `createOnly` is the "Share link…" path: a selection is shared by making it
 * an album first, so a public link always has an album behind it.
 */
export function AlbumPicker({
  albums,
  count,
  createOnly = false,
  busy,
  error,
  onPick,
  onCreate,
  onClose,
}: {
  albums: readonly Album[];
  count: number;
  createOnly?: boolean;
  busy: boolean;
  error: string | null;
  onPick: (album: Album) => void;
  onCreate: (title: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const valid = normalizeAlbumTitle(title) !== null;
  const noun = count === 1 ? "photo" : "photos";
  return (
    <Modal
      title={createOnly ? `Share ${count} ${noun}` : `Add ${count} ${noun} to an album`}
      onClose={onClose}
    >
      {createOnly ? (
        <p style={{ margin: 0, color: "#aaa" }}>
          A public link shows an album. Name one for these photos, and the link dialog opens next.
        </p>
      ) : albums.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {albums.map((album) => (
            <li key={album.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onPick(album)}
                style={{ ...buttonStyle, width: "100%", textAlign: "left", padding: "8px 12px" }}
              >
                {album.title}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) onCreate(title.trim());
        }}
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 6, color: "#aaa", fontSize: 13 }}>
          New album
          <input
            autoFocus
            value={title}
            maxLength={ALBUM_TITLE_MAX}
            placeholder="Album name"
            onChange={(e) => setTitle(e.target.value)}
            style={inputStyle}
          />
        </label>
        {error ? (
          <p role="alert" style={{ margin: 0, color: "#f88", fontSize: 13 }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" style={buttonStyle} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" style={primaryButtonStyle} disabled={!valid || busy}>
            {createOnly ? "Create album" : "Create and add"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
