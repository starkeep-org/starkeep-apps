import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * App-level cover image banner — the user-facing proving client for the
 * app-specific synced *file* plane. The cover is a single app-private file
 * (subKey "cover") stored via the platform's presign → direct-upload →
 * register flow; this component only talks to the photos-owned
 * `/api/photos/cover` route, never to the data server directly.
 */
export function CoverImageBanner(): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/photos/cover");
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
        const res = await fetch("/api/photos/cover", {
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
      await fetch("/api/photos/cover", { method: "DELETE" });
      setUrl(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div
      style={{
        position: "relative",
        borderBottom: "1px solid rgba(255,255,255,0.1)",
        background: url ? "#000" : "rgba(255,255,255,0.03)",
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onPick(file);
          e.target.value = "";
        }}
      />

      {url ? (
        <img
          src={url}
          alt="App cover"
          style={{ display: "block", width: "100%", maxHeight: 220, objectFit: "cover" }}
        />
      ) : (
        <div style={{ padding: "18px 20px", color: "#888", fontSize: 13 }}>
          No cover image set.
        </div>
      )}

      <div
        style={{
          position: url ? "absolute" : "static",
          right: 12,
          bottom: 12,
          display: "flex",
          gap: 8,
        }}
      >
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          style={coverButtonStyle}
        >
          {busy ? "Saving…" : url ? "Change cover" : "Set cover"}
        </button>
        {url && (
          <button onClick={() => void onRemove()} disabled={busy} style={coverButtonStyle}>
            Remove
          </button>
        )}
      </div>

      {error && (
        <div style={{ padding: "6px 20px", color: "#f88", fontSize: 12 }}>{error}</div>
      )}
    </div>
  );
}

const coverButtonStyle: React.CSSProperties = {
  background: "rgba(0,0,0,0.55)",
  border: "1px solid rgba(255,255,255,0.25)",
  color: "#fff",
  borderRadius: 4,
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: 12,
};
