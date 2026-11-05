import React, { useState } from "react";
import { normalizeAlbumTitle, type Album } from "@/photos-lib/client";
import { PublicBadge } from "./albums-view";
import { buttonStyle, inputStyle, primaryButtonStyle } from "./modal";

/** The top of an album: back to the albums, its title and count, and what can be done to it. */
export function AlbumHeader({
  album,
  count,
  linked,
  onBack,
  onRename,
  onDelete,
  onPublicLink,
}: {
  album: Album;
  count: number;
  linked: boolean;
  onBack: () => void;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onPublicLink: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(album.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: "12px 16px 0", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button type="button" style={buttonStyle} onClick={onBack}>
          ← Albums
        </button>
        {renaming ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const next = normalizeAlbumTitle(title);
              if (next === null) return;
              void act(async () => {
                await onRename(next);
                setRenaming(false);
              });
            }}
            style={{ display: "flex", gap: 8, flex: 1, maxWidth: 420 }}
          >
            <input
              autoFocus
              value={title}
              aria-label="Album name"
              onChange={(e) => setTitle(e.target.value)}
              style={inputStyle}
            />
            <button type="submit" style={primaryButtonStyle} disabled={busy || normalizeAlbumTitle(title) === null}>
              Save
            </button>
            <button type="button" style={buttonStyle} onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <h1 style={{ margin: 0, fontSize: 20, color: "#fff", display: "flex", alignItems: "center", gap: 10 }}>
            {album.title}
            <span style={{ fontSize: 13, color: "#888", fontWeight: 400 }}>
              {count} {count === 1 ? "photo" : "photos"}
            </span>
            {linked ? (
              <span style={{ position: "relative", display: "inline-block", width: 90, height: 20 }}>
                <PublicBadge />
              </span>
            ) : null}
          </h1>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" style={primaryButtonStyle} onClick={onPublicLink}>
            Public link…
          </button>
          {!renaming ? (
            <button
              type="button"
              style={buttonStyle}
              onClick={() => {
                setTitle(album.title);
                setRenaming(true);
              }}
            >
              Rename
            </button>
          ) : null}
          <button
            type="button"
            style={{ ...buttonStyle, color: "#f88" }}
            disabled={busy}
            onClick={() => {
              const link = linked ? " Its public link stops working too." : "";
              if (confirm(`Delete the album "${album.title}"? The photos stay in your library.${link}`)) {
                void act(onDelete);
              }
            }}
          >
            Delete album
          </button>
        </div>
      </div>
      {error ? (
        <p role="alert" style={{ margin: 0, color: "#f88", fontSize: 13 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
