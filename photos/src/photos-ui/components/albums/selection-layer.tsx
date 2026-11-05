import React, { useEffect, useState } from "react";
import type { Album } from "@/photos-lib/client";
import { retainShown } from "@/photos-lib/selection";
import type { AlbumsState } from "@/lib/use-albums";
import { useSelection } from "../../context/selection-context";
import { SelectionBar } from "../selection/selection-bar";
import { AlbumPicker } from "./album-picker";

/**
 * What a selection raises: the bar, and the album picker behind its buttons.
 * Lives under the selection provider, beside the grid it selects from.
 */
export function SelectionLayer({
  shownIds,
  album,
  albums,
  onShareAlbum,
}: {
  shownIds: ReadonlySet<string>;
  /** The open album, or null in the library. */
  album: Album | null;
  albums: AlbumsState;
  /** Open the public-link dialog for an album just made from the selection. */
  onShareAlbum: (album: Album) => void;
}) {
  const selection = useSelection()!;
  const [picker, setPicker] = useState<null | "add" | "share">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A photo that leaves the shown list — deleted, or out of this album — leaves
  // the selection with it.
  useEffect(() => {
    const kept = retainShown(selection.selection, shownIds);
    if (kept !== selection.selection) selection.set(kept);
  }, [shownIds, selection]);

  // Escape ends a selection, when no dialog is open to take the key first.
  useEffect(() => {
    if (!selection.selecting || picker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") selection.clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, picker]);

  if (!selection.selecting) return null;
  const ids = [...selection.selection.ids];

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setPicker(null);
      selection.clear();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Room for the bar, so it never covers the last row. */}
      <div style={{ height: 64 }} />
      <SelectionBar
        count={ids.length}
        inAlbum={album !== null}
        busy={busy}
        onAddToAlbum={() => {
          setError(null);
          setPicker("add");
        }}
        onRemoveFromAlbum={() => void run(() => albums.removeMembers(album!, ids))}
        onSetCover={() => void run(() => albums.setCover(album!, ids[0]!))}
        onShare={() => {
          setError(null);
          setPicker("share");
        }}
        onClear={selection.clear}
      />
      {picker ? (
        <AlbumPicker
          albums={albums.albums.filter((a) => a.id !== album?.id)}
          count={ids.length}
          createOnly={picker === "share"}
          busy={busy}
          error={error}
          onClose={() => setPicker(null)}
          onPick={(target) => void run(() => albums.addMembers(target, ids))}
          onCreate={(title) =>
            void run(async () => {
              const created = await albums.create(title);
              await albums.addMembers(created, ids);
              if (picker === "share") onShareAlbum(created);
            })
          }
        />
      ) : null}
    </>
  );
}
