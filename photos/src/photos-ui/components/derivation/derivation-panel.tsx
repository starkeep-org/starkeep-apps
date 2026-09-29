import { useEffect, useState } from "react";
import {
  DERIVATION_UNAVAILABLE,
  fetchDerivationConfig,
  updateDerivationConfig,
  type DerivationConfigShape,
} from "../../../lib/derivation-client";

/**
 * This machine's derivation switches: which stand-ins it makes in the
 * background, and whether it may download an original to make them.
 *
 * Renders nothing when the routes answer 501 — a cloud-served Photos runs no
 * sweep, so there is nothing to switch.
 */
export function DerivationPanel({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<DerivationConfigShape | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDerivationConfig()
      .then((next) => {
        if (cancelled) return;
        if (next === DERIVATION_UNAVAILABLE) setUnavailable(true);
        else setConfig(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = async (change: Partial<DerivationConfigShape>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await updateDerivationConfig(change);
      if (next === DERIVATION_UNAVAILABLE) setUnavailable(true);
      else setConfig(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (unavailable) return null;
  const deriving = config !== null && (config.derivePhotoStandIns || config.deriveVideoStandIns);

  return (
    <div style={backdropStyle} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={panelStyle} role="dialog" aria-label="Derivation on this machine">
        <div style={headerStyle}>
          <strong style={{ fontSize: 15 }}>Derivation on this machine</strong>
          <button onClick={onClose} style={closeStyle} aria-label="Close">
            ×
          </button>
        </div>
        <p style={noteStyle}>
          Photos makes smaller sizes of each photo and video in the background, so every device can
          show them without the original. Opening a photo still makes the size it needs, whatever
          these say.
        </p>

        {!config && !error && <p style={noteStyle}>Loading…</p>}

        {config && (
          <>
            <label style={rowStyle}>
              <input
                type="checkbox"
                checked={config.derivePhotoStandIns}
                disabled={busy}
                onChange={(e) => void patch({ derivePhotoStandIns: e.target.checked })}
              />
              <span>Derive photo stand-ins here</span>
            </label>
            <label style={rowStyle}>
              <input
                type="checkbox"
                checked={config.deriveVideoStandIns}
                disabled={busy}
                onChange={(e) => void patch({ deriveVideoStandIns: e.target.checked })}
              />
              <span>Derive video stand-ins here</span>
            </label>
            <label style={{ ...rowStyle, opacity: deriving ? 1 : 0.5 }}>
              <input
                type="checkbox"
                checked={config.downloadOriginalsToDerive}
                disabled={busy || !deriving}
                onChange={(e) => void patch({ downloadOriginalsToDerive: e.target.checked })}
              />
              <span>Download originals to derive missing stand-ins</span>
            </label>
            <p style={{ ...noteStyle, marginTop: -4 }}>
              A downloaded original stays on this machine until you free up space. Off, Photos
              derives only from originals already here.
            </p>
          </>
        )}

        {error && <p style={{ color: "#f88" }}>{error}</p>}
      </div>
    </div>
  );
}

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.6)",
  zIndex: 1100,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const panelStyle: React.CSSProperties = {
  background: "#1b1b1b",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 8,
  padding: 20,
  width: "min(560px, 92vw)",
  maxHeight: "88vh",
  overflowY: "auto",
  color: "#ddd",
  fontSize: 13,
  lineHeight: 1.5,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 8,
};

const closeStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#fff",
  fontSize: 22,
  cursor: "pointer",
  lineHeight: 1,
};

const noteStyle: React.CSSProperties = { color: "#999", margin: "8px 0" };

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  margin: "12px 0",
  cursor: "pointer",
};
