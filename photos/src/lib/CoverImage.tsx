import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { withBasePath } from "./base-path";

/**
 * App-level cover image — the user-facing proving client for the app-specific
 * synced *file* plane. The cover is a single app-private file (subKey "cover")
 * stored via the platform's presign → direct-upload → register flow; this
 * component only talks to the photos-owned `/api/photos/cover` route, never to
 * the data server directly.
 *
 * Split in two because the two halves belong in different places: the cover
 * itself is content and sits above the photo list, while setting and clearing
 * it is administration and sits in the settings menu. They share one piece of
 * state through this context, so changing the cover from the menu repaints the
 * banner without either half polling the other.
 */
interface CoverImageState {
  url: string | null;
  busy: boolean;
  error: string | null;
  pick: (file: File) => Promise<void>;
  remove: () => Promise<void>;
}

const CoverImageContext = createContext<CoverImageState | null>(null);

export function useCoverImage(): CoverImageState {
  const value = useContext(CoverImageContext);
  if (!value) throw new Error("useCoverImage must be used inside a CoverImageProvider");
  return value;
}

export function CoverImageProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(withBasePath("/api/photos/cover"));
      if (!res.ok) return;
      const { url: next } = (await res.json()) as { url: string | null };
      setUrl(next);
    } catch {
      // Best-effort: a missing cover is not an error worth surfacing.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onPick = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(withBasePath("/api/photos/cover"), {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Upload failed (${res.status})`);
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const onRemove = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await fetch(withBasePath("/api/photos/cover"), { method: "DELETE" });
      setUrl(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const value = useMemo<CoverImageState>(
    () => ({ url, busy, error, pick: onPick, remove: onRemove }),
    [url, busy, error, onPick, onRemove],
  );

  return <CoverImageContext.Provider value={value}>{children}</CoverImageContext.Provider>;
}

/**
 * The cover itself, above the photo list. Renders nothing at all when no cover
 * is set: an empty strip saying so is a permanent advertisement for a feature
 * most viewers have already decided about, and the way to set one is now in the
 * settings menu anyway.
 */
export function CoverImageBanner(): React.ReactElement | null {
  const { url } = useCoverImage();
  if (!url) return null;
  return (
    <div style={{ borderBottom: "1px solid rgba(255,255,255,0.1)", background: "#000" }}>
      <img
        src={url}
        alt="App cover"
        style={{ display: "block", width: "100%", maxHeight: 220, objectFit: "cover" }}
      />
    </div>
  );
}

/**
 * Setting, replacing and clearing the cover, for the settings menu.
 */
export function CoverImageControls(): React.ReactElement {
  const { url, busy, error, pick, remove } = useCoverImage();
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void pick(file);
          e.target.value = "";
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={() => fileInputRef.current?.click()} disabled={busy} style={coverButtonStyle}>
          {busy ? "Saving…" : url ? "Change cover" : "Set cover"}
        </button>
        {url && (
          <button onClick={() => void remove()} disabled={busy} style={coverButtonStyle}>
            Remove
          </button>
        )}
      </div>
      {error && <div style={{ color: "#f88", fontSize: 12 }}>{error}</div>}
    </div>
  );
}

const coverButtonStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.25)",
  color: "#fff",
  borderRadius: 4,
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: 12,
};
