import React, { useState } from "react";
import { coverOf, normalizeAlbumTitle, type Album, type AppImage } from "@/photos-lib/client";
import { PhotoThumbnail } from "../grid/photo-thumbnail";
import { NoSelection } from "../../context/selection-context";
import { buttonStyle, inputStyle, primaryButtonStyle } from "./modal";

const CARD_WIDTH = 180;
const CARD_HEIGHT = 135;

/**
 * Every album, with its cover, its title, how many photos it holds, and a
 * mark on the ones with a live public link.
 *
 * Members come from the library the page already holds: each photo carries
 * its albums from its `photos/album` labels, so this costs no request.
 */
export function AlbumsView({
  albums,
  membersOf,
  linkedAlbumIds,
  loading,
  error,
  onOpen,
  onCreate,
}: {
  albums: readonly Album[];
  membersOf: (albumId: string) => readonly AppImage[];
  linkedAlbumIds: ReadonlySet<string>;
  loading: boolean;
  error: string | null;
  onOpen: (album: Album) => void;
  onCreate: (title: string) => Promise<void>;
}) {
  const [naming, setNaming] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = normalizeAlbumTitle(title) !== null;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {naming ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!valid || busy) return;
              setBusy(true);
              try {
                await onCreate(title.trim());
                setTitle("");
                setNaming(false);
              } finally {
                setBusy(false);
              }
            }}
            style={{ display: "flex", gap: 8, flex: 1, maxWidth: 420 }}
          >
            <input
              autoFocus
              value={title}
              placeholder="Album name"
              aria-label="New album name"
              onChange={(e) => setTitle(e.target.value)}
              style={inputStyle}
            />
            <button type="submit" style={primaryButtonStyle} disabled={!valid || busy}>
              Create
            </button>
            <button type="button" style={buttonStyle} onClick={() => setNaming(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" style={primaryButtonStyle} onClick={() => setNaming(true)}>
            New album
          </button>
        )}
      </div>

      {error ? (
        <p role="alert" style={{ margin: 0, color: "#f88", fontSize: 13 }}>
          {error}
        </p>
      ) : null}

      {loading && albums.length === 0 ? (
        <p style={{ color: "#666" }}>Loading…</p>
      ) : albums.length === 0 ? (
        <p style={{ color: "#888" }}>
          No albums yet. Select photos in the library and choose "Add to album…", or make one here.
        </p>
      ) : (
        <NoSelection>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "grid",
              gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_WIDTH}px, 1fr))`,
              gap: 16,
            }}
          >
            {albums.map((album) => {
              const members = membersOf(album.id);
              const cover = coverOf(album, members);
              const count = members.length;
              return (
                <li key={album.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(album)}
                    aria-label={`Open album ${album.title}`}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      width: "100%",
                    }}
                  >
                    <div
                      style={{
                        position: "relative",
                        width: "100%",
                        height: CARD_HEIGHT,
                        borderRadius: 6,
                        overflow: "hidden",
                        background: "#222",
                        display: "flex",
                        justifyContent: "center",
                      }}
                    >
                      {cover ? (
                        <PhotoThumbnail
                          image={cover}
                          width={CARD_WIDTH * 1.4}
                          height={CARD_HEIGHT}
                          onSelect={() => onOpen(album)}
                        />
                      ) : null}
                      {linkedAlbumIds.has(album.id) ? <PublicBadge /> : null}
                    </div>
                    <span style={{ color: "#eee", fontWeight: 600, fontSize: 14 }}>{album.title}</span>
                    <span style={{ color: "#888", fontSize: 12 }}>
                      {count} {count === 1 ? "photo" : "photos"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </NoSelection>
      )}
    </div>
  );
}

/** The mark on an album with a live public link. */
export function PublicBadge() {
  return (
    <span
      title="Shared by public link"
      style={{
        position: "absolute",
        top: 6,
        right: 6,
        background: "rgba(47,111,214,0.9)",
        color: "#fff",
        fontSize: 11,
        fontWeight: 600,
        borderRadius: 10,
        padding: "2px 8px",
        pointerEvents: "none",
      }}
    >
      Public link
    </span>
  );
}
