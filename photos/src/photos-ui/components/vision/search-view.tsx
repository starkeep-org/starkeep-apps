import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  searchVision,
  VISION_UNAVAILABLE,
  type VisionSearchResponse,
  type VisionSearchTerm,
} from "../../../lib/vision-client";

/**
 * Search: a box, the parse rendered as removable chips, and score-ordered results.
 *
 * **Chips are for parse ambiguity, not filter strength** (plan §5.2). Person names
 * collide with common nouns far more than they first appear — Rose, Daisy, Iris,
 * Summer, Mark, Sunny, Robin, Jasmine — and `"rose at the beach"` is genuinely
 * ambiguous in a way no scoring can resolve, because the information is not in the
 * query. ✕ drops the *interpretation*, returning the word to the dense residual;
 * it is deliberately not a strength dial, which is what §5.1's weights are for.
 *
 * The chips are also a measurement instrument: which ones get removed is the
 * iteration signal for parse quality, available immediately with no eval set.
 *
 * **Plain score ordering, not banded sections.** §5.1 notes that making the bands
 * explicit is a natural refinement but a refinement — the route returns `bands`
 * alongside `results` so that stays a client decision, and this renders the flat
 * list that is the thing to try first.
 */

interface SearchViewProps {
  onClose: () => void;
  /** Resolve a record id to a thumbnail URL, so this component owns no URL policy. */
  thumbnailUrl: (recordId: string) => string | undefined;
  onSelect: (recordId: string) => void;
}

const DEBOUNCE_MS = 250;
const PAGE = 60;

export function SearchView({ onClose, thumbnailUrl, onSelect }: SearchViewProps) {
  const [query, setQuery] = useState("");
  const [dropped, setDropped] = useState<readonly string[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [response, setResponse] = useState<VisionSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Guards against an out-of-order reply overwriting a newer one: the query worker
  // is concurrent and a slow first search (which pays the model load) can land
  // after a fast second one.
  const generation = useRef(0);

  const run = useCallback(
    async (text: string, drop: readonly string[], take: number) => {
      const mine = ++generation.current;
      if (text.trim() === "") {
        setResponse(null);
        setError(null);
        return;
      }
      setBusy(true);
      try {
        const result = await searchVision(text, { dropped: drop, limit: take });
        if (mine !== generation.current) return;
        if (result === VISION_UNAVAILABLE) {
          onClose();
          return;
        }
        setResponse(result);
        setError(null);
      } catch (err) {
        if (mine !== generation.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mine === generation.current) setBusy(false);
      }
    },
    [onClose],
  );

  // Debounced, because the first search of a session loads the text tower and
  // every keystroke would otherwise queue another embed behind it.
  useEffect(() => {
    const timer = setTimeout(() => void run(query, dropped, limit), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, dropped, limit, run]);

  // A new query invalidates which chips were dismissed — the parse is different, so
  // the keys may not even exist.
  const onQueryChange = (text: string) => {
    setQuery(text);
    setDropped([]);
    setLimit(PAGE);
  };

  const dismiss = (term: VisionSearchTerm) => setDropped((prev) => [...prev, term.key]);
  const restoreAll = () => setDropped([]);

  const shown = response?.results ?? [];
  const hasMore = response !== null && response.total > shown.length;

  const summary = useMemo(() => {
    if (!response) return null;
    if (response.total === 0) return "No matches";
    const parts = [`${response.total} match${response.total === 1 ? "" : "es"}`];
    if (response.residual.trim() !== "") parts.push(`by description "${response.residual}"`);
    return parts.join(" ");
  }, [response]);

  return (
    <div style={overlay}>
      <div style={panel}>
        <header style={header}>
          <input
            autoFocus
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Alice at the beach"
            aria-label="Search photos"
            style={input}
          />
          <button onClick={onClose} aria-label="Close search" style={closeButton}>
            ×
          </button>
        </header>

        {response && response.terms.length > 0 && (
          <div style={chipRow}>
            {response.terms.map((term) => (
              <span key={term.key} style={chip}>
                <span aria-hidden>👤</span> {term.label}
                <button
                  onClick={() => dismiss(term)}
                  aria-label={`Not the person ${term.label}`}
                  title={`Search for "${term.matched}" as a word instead`}
                  style={chipDismiss}
                >
                  ✕
                </button>
              </span>
            ))}
            {response.residual.trim() !== "" && (
              <span style={residual}>{response.residual}</span>
            )}
          </div>
        )}

        {dropped.length > 0 && (
          <div style={notice}>
            {dropped.length} interpretation{dropped.length === 1 ? "" : "s"} dismissed
            <button onClick={restoreAll} style={linkButton}>
              undo
            </button>
          </div>
        )}

        {response?.denseUnavailable && <div style={notice}>{response.denseUnavailable}</div>}
        {error && <div style={errorBox}>{error}</div>}

        {summary && (
          <div style={summaryRow}>
            {summary}
            {busy && <span style={{ opacity: 0.6 }}> — searching…</span>}
          </div>
        )}

        <div style={grid}>
          {shown.map((result) => {
            const url = thumbnailUrl(result.recordId);
            return (
              <button
                key={result.recordId}
                onClick={() => onSelect(result.recordId)}
                style={tile}
                // Enough to explain a placement without a debug mode: which names
                // fired, and how strong the description match was.
                title={
                  `score ${result.score.toFixed(2)}` +
                  (result.matched.length > 0
                    ? ` · ${result.matched.map((t) => t.label).join(", ")}`
                    : "") +
                  (result.dense !== null ? ` · description ${result.dense.toFixed(2)}` : "")
                }
              >
                {url ? (
                  <img src={url} alt="" style={thumb} loading="lazy" />
                ) : (
                  <span style={missingThumb}>?</span>
                )}
              </button>
            );
          })}
        </div>

        {hasMore && (
          <button onClick={() => setLimit((n) => n + PAGE)} style={moreButton}>
            Show more ({response!.total - shown.length} more)
          </button>
        )}

        {response && response.total === 0 && !busy && (
          <p style={{ opacity: 0.6, fontSize: 13, padding: "0 4px" }}>
            Nothing matched. Names come from the People view, and descriptions need a
            scene scan.
          </p>
        )}
      </div>
    </div>
  );
}

// Inline styles, matching the other vision surfaces in this directory — the app
// has no CSS module or utility-class convention to follow here.
const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.72)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "48px 16px",
  zIndex: 60,
  overflowY: "auto",
};

const panel: React.CSSProperties = {
  width: "min(1100px, 100%)",
  background: "#15161a",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 12,
  padding: 20,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const header: React.CSSProperties = { display: "flex", gap: 12, alignItems: "center" };

const input: React.CSSProperties = {
  flex: 1,
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 8,
  padding: "10px 14px",
  color: "#f2f2f4",
  fontSize: 16,
};

const closeButton: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#f2f2f4",
  fontSize: 26,
  lineHeight: 1,
  cursor: "pointer",
};

const chipRow: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "center",
};

const chip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  background: "rgba(120,170,255,0.18)",
  border: "1px solid rgba(120,170,255,0.4)",
  borderRadius: 999,
  padding: "4px 10px",
  fontSize: 13,
  color: "#cfe0ff",
};

const chipDismiss: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
  marginLeft: 2,
};

const residual: React.CSSProperties = { fontSize: 13, opacity: 0.75 };

const notice: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  fontSize: 13,
  color: "#ffd86b",
  background: "rgba(255,200,60,0.1)",
  border: "1px solid rgba(255,200,60,0.25)",
  borderRadius: 8,
  padding: "8px 12px",
};

const errorBox: React.CSSProperties = { ...notice, color: "#ff9a8a", background: "rgba(255,80,60,0.12)", border: "1px solid rgba(255,80,60,0.3)" };

const linkButton: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "inherit",
  textDecoration: "underline",
  cursor: "pointer",
  fontSize: 13,
  padding: 0,
};

const summaryRow: React.CSSProperties = { fontSize: 13, opacity: 0.8 };

const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(128px, 1fr))",
  gap: 8,
};

const tile: React.CSSProperties = {
  padding: 0,
  border: "none",
  background: "rgba(255,255,255,0.04)",
  borderRadius: 8,
  overflow: "hidden",
  cursor: "pointer",
  aspectRatio: "1 / 1",
};

const thumb: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

const missingThumb: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  height: "100%",
  opacity: 0.4,
};

const moreButton: React.CSSProperties = {
  alignSelf: "center",
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 8,
  padding: "8px 16px",
  color: "#f2f2f4",
  cursor: "pointer",
  fontSize: 14,
};
