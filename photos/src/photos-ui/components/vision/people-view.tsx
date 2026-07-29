import { useCallback, useEffect, useState } from "react";
import {
  faceCropUrl,
  fetchPeople,
  mutatePeople,
  VISION_UNAVAILABLE,
  type VisionFaceRef,
  type VisionPerson,
} from "../../../lib/vision-client";

/**
 * The People view: clusters by size, with naming, merging, and splitting.
 *
 * The three operations exist because incremental assignment gets two things
 * wrong in opposite directions, and neither is fixable by tuning the threshold
 * after the fact:
 *   - **merge** — one person split across several clusters (different lighting,
 *     a decade apart);
 *   - **split** — two people fused into one cluster;
 *   - **rebuild** — the threshold itself was wrong, which no per-cluster edit
 *     can undo because a loose threshold has already destroyed the boundary.
 */

interface PeopleViewProps {
  onClose: () => void;
}

export function PeopleView({ onClose }: PeopleViewProps) {
  const [people, setPeople] = useState<VisionPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedFaces, setSelectedFaces] = useState<VisionFaceRef[]>([]);
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchPeople();
      if (result === VISION_UNAVAILABLE) {
        onClose();
        return;
      }
      setPeople(result.people);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onClose]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (body: Parameters<typeof mutatePeople>[0]) => {
    setBusy(true);
    setError(null);
    try {
      const result = await mutatePeople(body);
      if (result !== VISION_UNAVAILABLE) {
        setPeople(result.people);
        if (result.warning) setError(result.warning);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleFace = (ref: VisionFaceRef) => {
    setSelectedFaces((prev) => {
      const key = `${ref.recordId}:${ref.faceIndex}`;
      const without = prev.filter((f) => `${f.recordId}:${f.faceIndex}` !== key);
      return without.length === prev.length ? [...prev, ref] : without;
    });
  };

  const isSelected = (ref: VisionFaceRef) =>
    selectedFaces.some((f) => f.recordId === ref.recordId && f.faceIndex === ref.faceIndex);

  return (
    <div style={backdropStyle} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={panelStyle}>
        <div style={headerStyle}>
          <strong style={{ fontSize: 15 }}>People</strong>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={() => {
                // Destructive and irreversible: every name is lost, because the
                // clusters they named stop existing.
                if (window.confirm("Rebuild every group from scratch? All names will be lost.")) {
                  void act({ action: "recluster" });
                }
              }}
              disabled={busy}
              style={buttonStyle}
            >
              Rebuild groups
            </button>
            <button onClick={onClose} style={closeStyle} aria-label="Close">
              ×
            </button>
          </div>
        </div>

        {people === null && !error && <p style={noteStyle}>Loading…</p>}
        {people?.length === 0 && (
          <p style={noteStyle}>
            No faces grouped yet. Enable face detection and run a scan from the Face recognition
            panel.
          </p>
        )}

        {mergeSourceId && (
          <div style={bannerStyle}>
            Pick the group to merge into.
            <button onClick={() => setMergeSourceId(null)} style={linkStyle}>
              cancel
            </button>
          </div>
        )}

        {people?.map((person) => {
          const expanded = expandedId === person.id;
          const cover = person.faces[0];
          return (
            <div key={person.id} style={personRowStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {cover ? (
                  <img
                    src={faceCropUrl(cover)}
                    alt=""
                    width={56}
                    height={56}
                    style={{ borderRadius: 6, objectFit: "cover", background: "#222" }}
                  />
                ) : (
                  <div style={{ width: 56, height: 56, borderRadius: 6, background: "#222" }} />
                )}

                <input
                  defaultValue={person.name}
                  placeholder="Add a name"
                  disabled={busy}
                  // On blur, not on every keystroke: a rename republishes every
                  // label row for this person.
                  onBlur={(e) => {
                    if (e.target.value !== person.name) {
                      void act({ action: "rename", personId: person.id, name: e.target.value });
                    }
                  }}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  style={nameInputStyle}
                />

                <span style={{ color: "#888", minWidth: 70 }}>
                  {person.faceCount} {person.faceCount === 1 ? "photo" : "photos"}
                </span>

                {mergeSourceId && mergeSourceId !== person.id ? (
                  <button
                    onClick={() => {
                      void act({ action: "merge", targetId: person.id, sourceIds: [mergeSourceId] });
                      setMergeSourceId(null);
                    }}
                    disabled={busy}
                    style={buttonStyle}
                  >
                    Merge into this
                  </button>
                ) : (
                  <button
                    onClick={() => setMergeSourceId(mergeSourceId === person.id ? null : person.id)}
                    disabled={busy}
                    style={buttonStyle}
                  >
                    {mergeSourceId === person.id ? "Choosing…" : "Merge"}
                  </button>
                )}

                <button
                  onClick={() => {
                    setExpandedId(expanded ? null : person.id);
                    setSelectedFaces([]);
                  }}
                  style={buttonStyle}
                >
                  {expanded ? "Hide" : "Faces"}
                </button>
              </div>

              {expanded && (
                <div style={{ marginTop: 10 }}>
                  <div style={faceGridStyle}>
                    {person.faces.map((ref) => (
                      <img
                        key={`${ref.recordId}:${ref.faceIndex}`}
                        src={faceCropUrl(ref)}
                        alt=""
                        width={64}
                        height={64}
                        onClick={() => toggleFace(ref)}
                        style={{
                          borderRadius: 4,
                          objectFit: "cover",
                          background: "#222",
                          cursor: "pointer",
                          outline: isSelected(ref) ? "2px solid #6cf" : "2px solid transparent",
                        }}
                      />
                    ))}
                  </div>
                  <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ color: "#888" }}>
                      {selectedFaces.length === 0
                        ? "Select the faces that are not this person."
                        : `${selectedFaces.length} selected`}
                    </span>
                    <button
                      onClick={() => {
                        void act({ action: "split", faces: selectedFaces });
                        setSelectedFaces([]);
                      }}
                      disabled={busy || selectedFaces.length === 0}
                      style={buttonStyle}
                    >
                      Split into a new group
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {error && <div style={errorStyle}>{error}</div>}
      </div>
    </div>
  );
}

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.7)",
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
  width: "min(760px, 94vw)",
  maxHeight: "88vh",
  overflowY: "auto",
  color: "#ddd",
  fontSize: 13,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 12,
};

const closeStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#fff",
  fontSize: 22,
  cursor: "pointer",
  lineHeight: 1,
};

const personRowStyle: React.CSSProperties = {
  padding: "10px 0",
  borderTop: "1px solid rgba(255,255,255,0.08)",
};

const nameInputStyle: React.CSSProperties = {
  flex: 1,
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 4,
  color: "#fff",
  padding: "6px 10px",
  fontSize: 13,
};

const faceGridStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};

const buttonStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.10)",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#ddd",
  borderRadius: 4,
  padding: "5px 10px",
  cursor: "pointer",
  fontSize: 12,
  whiteSpace: "nowrap",
};

const linkStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#6cf",
  cursor: "pointer",
  fontSize: 12,
  marginLeft: 8,
};

const noteStyle: React.CSSProperties = { color: "#999", margin: "12px 0" };

const bannerStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 6,
  background: "rgba(100,200,255,0.10)",
  border: "1px solid rgba(100,200,255,0.25)",
  color: "#9dd",
  marginBottom: 8,
};

const errorStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 10,
  borderRadius: 6,
  background: "rgba(220,50,50,0.15)",
  color: "#f88",
};
