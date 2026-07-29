import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchVisionStatus,
  startVisionModelDownload,
  startVisionScan,
  stopVisionScan,
  updateVisionConfig,
  VISION_UNAVAILABLE,
  type VisionStatus,
} from "../../../lib/vision-client";

/**
 * Settings and the Scan card for on-device face recognition.
 *
 * Renders nothing at all when the routes answer 501 — a cloud-served Photos has
 * no models, no `app-local/` directory, and no business offering the toggle. A
 * disabled control would imply the feature is coming; its absence is accurate.
 *
 * `objects` and `scene` are deliberately not here. Their tasks are not built,
 * and a toggle for something that does nothing is worse than no toggle.
 */

const POLL_IDLE_MS = 4000;
const POLL_SCANNING_MS = 1000;

function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

interface VisionPanelProps {
  onClose: () => void;
  /** Opens the People view; the panel is the natural place to reach it from. */
  onOpenPeople: () => void;
}

export function VisionPanel({ onClose, onOpenPeople }: VisionPanelProps) {
  const [status, setStatus] = useState<VisionStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchVisionStatus();
      if (!mounted.current) return;
      if (next === VISION_UNAVAILABLE) {
        setUnavailable(true);
        return;
      }
      setStatus(next);
      setError(null);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  // Poll faster while a pass is running: a scan card that updates every four
  // seconds during a 45-minute pass reads as frozen. A download's progress bar
  // has the same problem, so it gets the same rate.
  const scanning = status?.scan.running ?? false;
  const downloading = status?.models.download.running ?? false;
  useEffect(() => {
    if (unavailable) return;
    const id = setInterval(
      () => void refresh(),
      scanning || downloading ? POLL_SCANNING_MS : POLL_IDLE_MS,
    );
    return () => clearInterval(id);
  }, [refresh, scanning, downloading, unavailable]);

  const patchConfig = async (patch: { faces: Partial<VisionStatus["config"]["faces"]> }) => {
    setBusy(true);
    setError(null);
    try {
      const result = await updateVisionConfig(patch);
      if (result !== VISION_UNAVAILABLE && result.warning) setError(result.warning);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * The button is the licence acceptance — see `/api/vision/models`. Refreshing
   * straight after start is what swaps the prompt for the progress bar without
   * waiting out a poll interval.
   */
  const downloadModels = async () => {
    setBusy(true);
    setError(null);
    try {
      await startVisionModelDownload();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleScan = async () => {
    setBusy(true);
    setError(null);
    try {
      await (scanning ? stopVisionScan() : startVisionScan());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (unavailable) return null;

  const ready = (status?.models.installed ?? false) && (status?.worker.built ?? false);
  const processed = status?.scan.processed.faces ?? 0;
  const eligible = status?.scan.eligible ?? 0;

  return (
    <div style={backdropStyle} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={panelStyle}>
        <div style={headerStyle}>
          <strong style={{ fontSize: 15 }}>Face recognition</strong>
          <button onClick={onClose} style={closeStyle} aria-label="Close">
            ×
          </button>
        </div>

        <p style={noteStyle}>
          Runs entirely on this device. Faces, identity vectors, and names are stored locally and
          never sync.
        </p>

        {!status && !error && <p style={noteStyle}>Loading…</p>}

        {status &&
          (status.models.installed ? (
            <ModelsInstalledBadge models={status.models} />
          ) : (
            <ModelDownloadPrompt
              models={status.models}
              busy={busy}
              onDownload={() => void downloadModels()}
            />
          ))}

        {status && status.models.installed && !status.worker.built && (
          <div style={warnStyle}>
            <div>The scan worker has not been built.</div>
            <code style={codeStyle}>{status.worker.buildCommand}</code>
          </div>
        )}

        {status && (
          <>
            <label style={rowStyle}>
              <input
                type="checkbox"
                checked={status.config.faces.enabled}
                disabled={busy || !status.models.installed}
                onChange={(e) => void patchConfig({ faces: { enabled: e.target.checked } })}
              />
              <span>Detect faces in my photos</span>
            </label>

            <label style={{ ...rowStyle, opacity: status.config.faces.enabled ? 1 : 0.5 }}>
              <span style={{ minWidth: 130 }}>Match threshold</span>
              <input
                type="range"
                min={0.2}
                max={0.8}
                step={0.01}
                value={status.config.faces.threshold}
                disabled={busy || !status.config.faces.enabled}
                onChange={(e) => void patchConfig({ faces: { threshold: Number(e.target.value) } })}
                style={{ flex: 1 }}
              />
              <span style={{ width: 36, textAlign: "right" }}>
                {status.config.faces.threshold.toFixed(2)}
              </span>
            </label>
            <p style={{ ...noteStyle, marginTop: -4 }}>
              Higher is stricter. Changing it only affects faces found from now on — use{" "}
              <em>Rebuild groups</em> in People to re-sort the ones you already have.
            </p>

            <label style={{ ...rowStyle, opacity: status.config.faces.enabled ? 1 : 0.5 }}>
              <input
                type="checkbox"
                checked={status.config.faces.publishLabels}
                disabled={busy || !status.config.faces.enabled}
                onChange={(e) => void patchConfig({ faces: { publishLabels: e.target.checked } })}
              />
              <span>Share names and face counts with other apps</span>
            </label>
            <p style={{ ...noteStyle, marginTop: -4 }}>
              Publishes <code>photos/faces</code> and <code>photos/face-count</code> as record
              labels. Any app that can read your images will then be able to list who is in them.
              Turning this off retracts what was published.
            </p>

            <div style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong>Scan</strong>
                <button
                  onClick={() => void toggleScan()}
                  disabled={busy || !ready || (!scanning && !status.config.faces.enabled)}
                  style={buttonStyle}
                >
                  {scanning ? "Stop" : "Scan now"}
                </button>
              </div>

              <div style={statLineStyle}>
                <span>Faces</span>
                <span>
                  {processed} / {eligible || status.store.processed} processed
                  {status.scan.skipped > 0 ? ` · ${status.scan.skipped} already done` : ""}
                  {status.scan.failed > 0 ? ` · ${status.scan.failed} failed` : ""}
                </span>
              </div>
              <div style={statLineStyle}>
                <span>Found</span>
                <span>
                  {status.store.facesFound} faces in {status.store.imagesWithFaces} photos ·{" "}
                  {status.store.namedPeople} of {status.store.people} groups named
                </span>
              </div>
              {status.store.sidecarsOnDisk > status.store.processed && (
                <div style={statLineStyle}>
                  <span>Stale</span>
                  <span>
                    {status.store.sidecarsOnDisk - status.store.processed} results from an older
                    model — the next scan redoes them
                  </span>
                </div>
              )}
              {status.scan.error && <div style={{ ...statLineStyle, color: "#f88" }}>
                <span>Last run</span>
                <span>{status.scan.error}</span>
              </div>}

              <button onClick={onOpenPeople} style={{ ...buttonStyle, marginTop: 10 }}>
                People ({status.store.people})
              </button>
            </div>
          </>
        )}

        {error && <div style={{ ...warnStyle, color: "#f88" }}>{error}</div>}
      </div>
    </div>
  );
}

/**
 * Standing confirmation of which weights are installed — the resting state of
 * the same slot the download prompt occupies.
 *
 * Standing rather than a toast on completion: the question it answers is not
 * "did the download finish" but "what am I running", and that one is asked
 * months later, by someone wondering whether a bad grouping is the model's
 * fault. The pack name is the answer, and it is otherwise only visible in a
 * sidecar's `model` field.
 *
 * The directory is a `title` rather than a line of its own: an absolute path
 * under `$STARKEEP_DIR` is long, and wanting it is rarer than wanting to know
 * the thing is there at all.
 */
function ModelsInstalledBadge({ models }: { models: VisionStatus["models"] }) {
  return (
    <div style={okStyle} title={models.dir}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span>✓ {models.pack.name} models installed</span>
        <span style={{ opacity: 0.7 }}>{mb(models.pack.totalBytes)}</span>
      </div>
      <div style={{ opacity: 0.7, marginTop: 4 }}>{models.pack.files.join(" · ")}</div>
    </div>
  );
}

/**
 * The one thing standing between a fresh install and the feature working: 278 MB
 * of weights that are not shipped with the app.
 *
 * Three states, one box. The explanation is deliberately two lines — the size,
 * because a quarter-gigabyte download is not something to start on someone's
 * behalf without saying so, and the licence, because clicking the button is the
 * acceptance of it. The full terms are in the file the download leaves next to
 * the weights; a paragraph of licence text here would be read by nobody.
 *
 * `pnpm vision:fetch-models` stays on screen, small: it is the answer when the
 * download keeps failing, and the only path on a headless install.
 */
function ModelDownloadPrompt({
  models,
  busy,
  onDownload,
}: {
  models: VisionStatus["models"];
  busy: boolean;
  onDownload: () => void;
}) {
  const { download } = models;

  if (download.running) {
    const pct =
      download.bytesTotal > 0
        ? Math.min(100, Math.round((download.bytesReceived / download.bytesTotal) * 100))
        : 0;
    return (
      <div style={warnStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span>Downloading face models…</span>
          <span>
            {mb(download.bytesReceived)} / {mb(download.bytesTotal)}
          </span>
        </div>
        <div style={progressTrackStyle}>
          <div style={{ ...progressBarStyle, width: `${pct}%` }} />
        </div>
        <div style={{ opacity: 0.7, marginTop: 6 }}>
          {download.currentFile ?? "starting"} — you can close this panel; the download continues.
        </div>
      </div>
    );
  }

  return (
    <div style={warnStyle}>
      {download.error ? (
        // The failed transfer left nothing behind, so this really is a retry and
        // not a resume — saying so avoids the "didn't it already get half of it?"
        // question.
        <div style={{ color: "#f88" }}>Download failed: {download.error}</div>
      ) : (
        <div>Face recognition needs a one-time {mb(models.missingBytes)} model download.</div>
      )}
      <div style={{ opacity: 0.7, marginTop: 4 }}>
        InsightFace antelopev2 weights — licensed for non-commercial research use only. Downloading
        them accepts that.
      </div>
      <button onClick={onDownload} disabled={busy} style={{ ...buttonStyle, marginTop: 10 }}>
        {download.error ? "Try again" : `Download ${mb(models.missingBytes)}`}
      </button>
      <div style={{ opacity: 0.55, marginTop: 8 }}>
        Or from a shell: <code style={codeStyle}>{models.fetchCommand}</code>
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

const cardStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 12,
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 6,
  background: "rgba(255,255,255,0.03)",
};

const statLineStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  marginTop: 8,
  color: "#aaa",
};

const warnStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 10,
  borderRadius: 6,
  background: "rgba(255,200,60,0.10)",
  border: "1px solid rgba(255,200,60,0.25)",
  color: "#ffd86b",
};

/** `warnStyle`'s counterpart — same box, resolved rather than pending. */
const okStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 10,
  borderRadius: 6,
  background: "rgba(90,200,120,0.10)",
  border: "1px solid rgba(90,200,120,0.25)",
  color: "#8fdca6",
};

const progressTrackStyle: React.CSSProperties = {
  marginTop: 8,
  height: 6,
  borderRadius: 3,
  background: "rgba(0,0,0,0.35)",
  overflow: "hidden",
};

const progressBarStyle: React.CSSProperties = {
  height: "100%",
  background: "#ffd86b",
  // The poll is 1 s; without this the bar steps rather than moves.
  transition: "width 1s linear",
};

const codeStyle: React.CSSProperties = {
  display: "inline-block",
  marginTop: 6,
  padding: "2px 6px",
  background: "rgba(0,0,0,0.4)",
  borderRadius: 4,
  fontFamily: "ui-monospace, monospace",
};

const buttonStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.12)",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#ddd",
  borderRadius: 4,
  padding: "6px 14px",
  cursor: "pointer",
  fontSize: 13,
};
