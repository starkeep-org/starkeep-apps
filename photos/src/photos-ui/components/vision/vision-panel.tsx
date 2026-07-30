import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchVisionStatus,
  startVisionModelDownload,
  startVisionScan,
  stopVisionScan,
  updateVisionConfig,
  VISION_UNAVAILABLE,
  type VisionModelDownload,
  type VisionModelGroup,
  type VisionModelGroupName,
  type VisionStatus,
} from "../../../lib/vision-client";

/**
 * Settings and the Scan card for on-device vision.
 *
 * Renders nothing at all when the routes answer 501 — a cloud-served Photos has
 * no models, no `app-local/` directory, and no business offering the toggles. A
 * disabled control would imply the feature is coming; its absence is accurate.
 *
 * **A card per task** (plan §3.5). Each names its own download, its own licence,
 * and its own counts, because those genuinely differ: faces is 278 MB of
 * non-commercial weights, scene is 1.7 GB of Apache-2.0 ones, and conflating them
 * would either demand a licence acceptance that does not apply or hide one that
 * does.
 *
 * The **Scan** card stays singular below them, because one pass runs every enabled
 * task over one decode of each photo — that is the whole point of the task
 * registry, and two scan buttons would imply two passes.
 *
 * `objects` is deliberately absent: its task is not built, and a toggle for
 * something that does nothing is worse than no toggle.
 */

const POLL_IDLE_MS = 4000;
const POLL_SCANNING_MS = 1000;

function mb(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 / 1024)} MB`;
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
  // seconds during a multi-hour pass reads as frozen. A download's progress bar
  // has the same problem, so it gets the same rate.
  const scanning = status?.scan.running ?? false;
  const downloading = status?.download.running ?? false;
  useEffect(() => {
    if (unavailable) return;
    const id = setInterval(
      () => void refresh(),
      scanning || downloading ? POLL_SCANNING_MS : POLL_IDLE_MS,
    );
    return () => clearInterval(id);
  }, [refresh, scanning, downloading, unavailable]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const result = (await run()) as { warning?: string } | typeof VISION_UNAVAILABLE;
      if (result !== VISION_UNAVAILABLE && result?.warning) setError(result.warning);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (unavailable) return null;

  const ready = (status?.worker.built ?? false) && anyTaskInstalled(status);

  return (
    <div style={backdropStyle} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={panelStyle}>
        <div style={headerStyle}>
          <strong style={{ fontSize: 15 }}>On-device vision</strong>
          <button onClick={onClose} style={closeStyle} aria-label="Close">
            ×
          </button>
        </div>

        <p style={noteStyle}>
          Runs entirely on this device. Everything it derives — faces, identity vectors, names,
          embeddings — is stored locally and never syncs.
        </p>

        {!status && !error && <p style={noteStyle}>Loading…</p>}

        {status && !status.worker.built && (
          <div style={warnStyle}>
            <div>The scan worker has not been built.</div>
            <code style={codeStyle}>{status.worker.buildCommand}</code>
          </div>
        )}

        {status && (
          <>
            <TaskCard
              group={status.tasks.faces.models}
              name="faces"
              download={status.download}
              busy={busy}
              enabled={status.config.faces.enabled}
              onDownload={() => void act(() => startVisionModelDownload("faces"))}
              onToggle={(enabled) => void act(() => updateVisionConfig({ faces: { enabled } }))}
            >
              <label style={{ ...rowStyle, opacity: status.config.faces.enabled ? 1 : 0.5 }}>
                <span style={{ minWidth: 130 }}>Match threshold</span>
                <input
                  type="range"
                  min={0.2}
                  max={0.8}
                  step={0.01}
                  value={status.config.faces.threshold}
                  disabled={busy || !status.config.faces.enabled}
                  onChange={(e) =>
                    void act(() =>
                      updateVisionConfig({ faces: { threshold: Number(e.target.value) } }),
                    )
                  }
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
                  onChange={(e) =>
                    void act(() =>
                      updateVisionConfig({ faces: { publishLabels: e.target.checked } }),
                    )
                  }
                />
                <span>Share names and face counts with other apps</span>
              </label>
              <p style={{ ...noteStyle, marginTop: -4 }}>
                Publishes <code>photos/faces</code> and <code>photos/face-count</code> as record
                labels. Any app that can read your images will then be able to list who is in them.
                Turning this off retracts what was published.
              </p>

              <div style={statLineStyle}>
                <span>Found</span>
                <span>
                  {status.tasks.faces.store.facesFound} faces in{" "}
                  {status.tasks.faces.store.imagesWithFaces} photos ·{" "}
                  {status.tasks.faces.store.namedPeople} of {status.tasks.faces.store.people} groups
                  named
                </span>
              </div>
              <StaleLine store={status.tasks.faces.store} />
              <button onClick={onOpenPeople} style={{ ...buttonStyle, marginTop: 10 }}>
                People ({status.tasks.faces.store.people})
              </button>
            </TaskCard>

            <TaskCard
              group={status.tasks.scene.models}
              name="scene"
              download={status.download}
              busy={busy}
              enabled={status.config.scene.enabled}
              onDownload={() => void act(() => startVisionModelDownload("scene"))}
              onToggle={(enabled) => void act(() => updateVisionConfig({ scene: { enabled } }))}
            >
              <p style={{ ...noteStyle, marginTop: -4 }}>
                Describes each photo as a vector so it can be searched by what is in it. This is the
                slow one — around a second and a half per photo, so a first pass over a few thousand
                photos runs for hours. It resumes where it left off.
              </p>
              <div style={statLineStyle}>
                <span>Described</span>
                <span>{status.tasks.scene.store.processed} photos</span>
              </div>
              <div style={statLineStyle}>
                <span>Searchable</span>
                <span>
                  {status.tasks.scene.store.indexReady
                    ? `${status.tasks.scene.store.indexed} photos in the search index`
                    : "the search index is rebuilt at the end of a scan"}
                </span>
              </div>
              <StaleLine store={status.tasks.scene.store} />
            </TaskCard>

            <SearchCard
              search={status.search}
              download={status.download}
              busy={busy}
              onDownload={() => void act(() => startVisionModelDownload("search"))}
            />

            <div style={cardStyle}>
              <div
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                <strong>Scan</strong>
                <button
                  onClick={() => void act(() => (scanning ? stopVisionScan() : startVisionScan()))}
                  disabled={busy || !ready || (!scanning && !anyTaskEnabled(status))}
                  style={buttonStyle}
                >
                  {scanning ? "Stop" : "Scan now"}
                </button>
              </div>
              <p style={{ ...noteStyle, marginTop: 6 }}>
                One pass runs every task you have turned on, reading each photo once.
              </p>

              {/* Per task, because one counter cannot describe two tasks at
                  different points through the same pass — a task enabled today has
                  everything to do while a task enabled last month has nothing. */}
              <div style={statLineStyle}>
                <span>Faces</span>
                <span>{describeProgress(status, "faces")}</span>
              </div>
              <div style={statLineStyle}>
                <span>Scene</span>
                <span>{describeProgress(status, "scene")}</span>
              </div>
              {(status.scan.skipped > 0 || status.scan.failed > 0) && (
                <div style={statLineStyle}>
                  <span>Other</span>
                  <span>
                    {status.scan.skipped > 0 ? `${status.scan.skipped} already done` : ""}
                    {status.scan.skipped > 0 && status.scan.failed > 0 ? " · " : ""}
                    {status.scan.failed > 0 ? `${status.scan.failed} failed` : ""}
                  </span>
                </div>
              )}
              {status.scan.error && (
                <div style={{ ...statLineStyle, color: "#f88" }}>
                  <span>Last run</span>
                  <span>{status.scan.error}</span>
                </div>
              )}
            </div>
          </>
        )}

        {error && <div style={{ ...warnStyle, color: "#f88" }}>{error}</div>}
      </div>
    </div>
  );
}

function anyTaskEnabled(status: VisionStatus): boolean {
  return status.config.faces.enabled || status.config.scene.enabled;
}

function anyTaskInstalled(status: VisionStatus | null): boolean {
  if (!status) return false;
  return status.tasks.faces.models.installed || status.tasks.scene.models.installed;
}

/**
 * `processed` counts what *this pass* ran, which is not the same as what exists —
 * so a task that skipped everything reads "up to date" rather than "0 processed".
 */
function describeProgress(status: VisionStatus, task: "faces" | "scene"): string {
  if (!status.config[task].enabled) return "off";
  if (!status.tasks[task].models.installed) return "models not installed";
  const processed = status.scan.processed[task] ?? 0;
  const eligible = status.scan.eligible;
  if (status.scan.running) return `${processed} of ${eligible} this pass`;
  if (processed > 0) return `${processed} processed on the last pass`;
  return `up to date (${status.tasks[task].store.processed} stored)`;
}

/** The gap between what is on disk and what this build would keep. */
function StaleLine({ store }: { store: { processed: number; sidecarsOnDisk: number } }) {
  if (store.sidecarsOnDisk <= store.processed) return null;
  return (
    <div style={statLineStyle}>
      <span>Stale</span>
      <span>
        {store.sidecarsOnDisk - store.processed} results from an older model — the next scan redoes
        them
      </span>
    </div>
  );
}

/**
 * One task: its models, its toggle, and whatever controls and counts are its own.
 *
 * The model state and the toggle are always adjacent and in that order, because
 * the toggle is meaningless until the weights exist — and disabling it without
 * saying why is the version of this that generates support questions.
 */
function TaskCard({
  group,
  name,
  download,
  busy,
  enabled,
  onDownload,
  onToggle,
  children,
}: {
  group: VisionModelGroup;
  name: VisionModelGroupName;
  download: VisionModelDownload;
  busy: boolean;
  enabled: boolean;
  onDownload: () => void;
  onToggle: (enabled: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div style={cardStyle}>
      <strong>{group.label}</strong>
      <div style={{ ...noteStyle, marginTop: 4 }}>Used to {group.purpose}.</div>

      {group.installed ? (
        <ModelsInstalledBadge group={group} />
      ) : (
        <ModelDownloadPrompt
          group={group}
          name={name}
          download={download}
          busy={busy}
          onDownload={onDownload}
        />
      )}

      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || !group.installed}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span>Enable</span>
      </label>

      {children}
    </div>
  );
}

/**
 * Search has models but no toggle and no scan, which is why it is not a `TaskCard`.
 *
 * It is enabled by scene being scanned — an embedding with nothing querying it is
 * inert, and a search over no embeddings is an empty page, so the two are one
 * feature and a second switch would only be a way to break it.
 */
function SearchCard({
  search,
  download,
  busy,
  onDownload,
}: {
  search: VisionStatus["search"];
  download: VisionModelDownload;
  busy: boolean;
  onDownload: () => void;
}) {
  return (
    <div style={cardStyle}>
      <strong>{search.models.label}</strong>
      <div style={{ ...noteStyle, marginTop: 4 }}>Used to {search.models.purpose}.</div>

      {search.models.installed ? (
        <ModelsInstalledBadge group={search.models} />
      ) : (
        <ModelDownloadPrompt
          group={search.models}
          name="search"
          download={download}
          busy={busy}
          onDownload={onDownload}
        />
      )}

      <div style={statLineStyle}>
        <span>Status</span>
        <span>
          {!search.models.installed
            ? "needs the text model above"
            : !search.workerBuilt
              ? "the query worker has not been built"
              : search.ready
                ? "ready"
                : "waiting on a scene scan"}
        </span>
      </div>
      <p style={{ ...noteStyle, marginTop: 4 }}>
        Searching by name works as soon as you have named someone in People. Searching by
        description also needs Scene above.
      </p>
    </div>
  );
}

/**
 * Standing confirmation of which weights are installed.
 *
 * Standing rather than a toast on completion: the question it answers is not "did
 * the download finish" but "what am I running", and that one is asked months
 * later, by someone wondering whether a bad result is the model's fault. The pack
 * name is the answer, and it is otherwise only visible in a sidecar's `model`
 * field.
 *
 * The directory is a `title` rather than a line of its own: an absolute path under
 * `$STARKEEP_DIR` is long, and wanting it is rarer than wanting to know the thing
 * is there at all.
 */
function ModelsInstalledBadge({ group }: { group: VisionModelGroup }) {
  return (
    <div style={okStyle} title={group.dir}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span>✓ {group.pack.name} installed</span>
        <span style={{ opacity: 0.7 }}>{mb(group.pack.totalBytes)}</span>
      </div>
      <div style={{ opacity: 0.7, marginTop: 4 }}>{group.pack.files.join(" · ")}</div>
    </div>
  );
}

/**
 * The one thing standing between a fresh install and a task working: weights that
 * are not shipped with the app.
 *
 * The size is stated because a download this large is not something to start on
 * someone's behalf silently, and the licence is stated because for the face
 * weights, clicking the button *is* the acceptance. Only the restricted group says
 * so — telling someone that Apache-2.0 weights carry a restriction would be as
 * wrong as hiding that antelopev2 does.
 *
 * The shell command stays on screen, small: it is the answer when the download
 * keeps failing, and the only path on a headless install.
 */
function ModelDownloadPrompt({
  group,
  name,
  download,
  busy,
  onDownload,
}: {
  group: VisionModelGroup;
  name: VisionModelGroupName;
  download: VisionModelDownload;
  busy: boolean;
  onDownload: () => void;
}) {
  // One transfer at a time across all groups, so a running download belongs to
  // whichever card it names — the others show their prompt, disabled.
  const mine = download.running && download.group === name;
  const otherRunning = download.running && download.group !== name;

  if (mine) {
    const pct =
      download.bytesTotal > 0
        ? Math.min(100, Math.round((download.bytesReceived / download.bytesTotal) * 100))
        : 0;
    return (
      <div style={warnStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span>Downloading…</span>
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

  const failedHere = download.group === name && download.error;

  return (
    <div style={warnStyle}>
      {failedHere ? (
        // The failed transfer left nothing behind, so this really is a retry and
        // not a resume — saying so avoids the "didn't it already get half of it?"
        // question.
        <div style={{ color: "#f88" }}>Download failed: {download.error}</div>
      ) : (
        <div>Needs a one-time {mb(group.missingBytes)} model download.</div>
      )}
      <div style={{ opacity: 0.7, marginTop: 4 }}>
        {group.pack.name} — {group.licence}
        {group.needsAck ? ". Downloading them accepts that." : ""}
      </div>
      <button onClick={onDownload} disabled={busy || otherRunning} style={{ ...buttonStyle, marginTop: 10 }}>
        {otherRunning
          ? "Another download is running"
          : failedHere
            ? "Try again"
            : `Download ${mb(group.missingBytes)}`}
      </button>
      <div style={{ opacity: 0.55, marginTop: 8 }}>
        Or from a shell: <code style={codeStyle}>{group.fetchCommand}</code>
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
