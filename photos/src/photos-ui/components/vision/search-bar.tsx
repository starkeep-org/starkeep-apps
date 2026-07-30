import { useCallback, useEffect, useRef, useState } from "react";
import {
  searchVision,
  VISION_UNAVAILABLE,
  type VisionSearchResponse,
  type VisionSearchTerm,
} from "../../../lib/vision-client";

/**
 * The search box, inline above the grid — a **filter on the main photo list**
 * rather than a second list of its own.
 *
 * That choice costs something worth naming: search produces a *relevance* order and
 * the grid is grouped by date, and the two cannot both be honoured. Filtering keeps
 * the date grouping and discards the ranking *within* the result set — you still get
 * the top-k most relevant photos, laid out where they belong chronologically. The
 * ranking is not wasted, it decides *membership* rather than position, which is what
 * makes "filter the library I already know how to read" work.
 *
 * §5.3 rules out an absolute cutoff — cosine is uncalibrated, so a fixed threshold
 * returns the library or nothing depending on phrasing. So the filter is top-k, and
 * `limit` is the knob: raising it widens the filter rather than extending a page.
 *
 * The component owns the query and reports matches upward; the parent owns the grid.
 * It renders nothing at all when the vision routes answer 501, so a cloud-served
 * Photos simply has no search box.
 */

const DEBOUNCE_MS = 250;

export interface SearchMatches {
  /** Original record ids that matched, best first. Null means "not searching". */
  recordIds: readonly string[] | null;
  /** Total before `limit`, so the parent can offer to widen. */
  total: number;
}

interface SearchBarProps {
  onMatchesChange: (matches: SearchMatches) => void;
  /** How many results the filter admits. */
  limit: number;
  onWiden: () => void;
}

export function SearchBar({ onMatchesChange, limit, onWiden }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [dropped, setDropped] = useState<readonly string[]>([]);
  const [response, setResponse] = useState<VisionSearchResponse | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against an out-of-order reply overwriting a newer one: the query worker is
  // concurrent, and a first search that pays the model load can land after a fast
  // second one.
  const generation = useRef(0);

  const run = useCallback(
    async (text: string, drop: readonly string[], take: number) => {
      const mine = ++generation.current;
      if (text.trim() === "") {
        setResponse(null);
        setError(null);
        onMatchesChange({ recordIds: null, total: 0 });
        return;
      }
      setBusy(true);
      try {
        const result = await searchVision(text, { dropped: drop, limit: take });
        if (mine !== generation.current) return;
        if (result === VISION_UNAVAILABLE) {
          setUnavailable(true);
          onMatchesChange({ recordIds: null, total: 0 });
          return;
        }
        setResponse(result);
        setError(null);
        onMatchesChange({
          recordIds: result.results.map((r) => r.recordId),
          total: result.total,
        });
      } catch (err) {
        if (mine !== generation.current) return;
        setError(err instanceof Error ? err.message : String(err));
        // A failed search must not leave the grid showing a stale filter — that would
        // read as "these are your matches" for a search that did not happen.
        onMatchesChange({ recordIds: null, total: 0 });
      } finally {
        if (mine === generation.current) setBusy(false);
      }
    },
    [onMatchesChange],
  );

  // Debounced, because the first search of a session loads the text tower and every
  // keystroke would otherwise queue another embed behind it.
  useEffect(() => {
    const timer = setTimeout(() => void run(query, dropped, limit), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, dropped, limit, run]);

  if (unavailable) return null;

  // A new query invalidates which chips were dismissed — the parse is different, so
  // the keys may not even exist.
  const onQueryChange = (text: string) => {
    setQuery(text);
    setDropped([]);
  };

  const clear = () => {
    setQuery("");
    setDropped([]);
  };

  const dismiss = (term: VisionSearchTerm) => setDropped((prev) => [...prev, term.key]);

  const searching = query.trim() !== "";
  const shown = response?.results.length ?? 0;
  const hasMore = response !== null && response.total > shown;

  return (
    <div style={wrapStyle}>
      <div style={rowStyle}>
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search by person or description…"
          aria-label="Search photos"
          style={inputStyle}
        />
        {searching && (
          <button onClick={clear} aria-label="Clear search" style={clearStyle}>
            ✕
          </button>
        )}
        {searching && (
          <span style={countStyle}>
            {busy && response === null
              ? "searching…"
              : `${response?.total ?? 0} match${(response?.total ?? 0) === 1 ? "" : "es"}`}
            {busy && response !== null ? " …" : ""}
          </span>
        )}
        {hasMore && (
          <button onClick={onWiden} style={widenStyle}>
            Show more
          </button>
        )}
      </div>

      {/* Chips are for parse ambiguity, not filter strength (§5.2). Person names
          collide with common nouns far more than they first appear — Rose, Daisy,
          Iris, Summer, Mark — and no scoring resolves that, because the information
          is not in the query. ✕ drops the interpretation and returns the word to the
          description half. */}
      {response && response.terms.length > 0 && (
        <div style={chipRowStyle}>
          {response.terms.map((term) => (
            <span key={term.key} style={term.kind === "person" ? personChip : objectChip}>
              <span aria-hidden>{term.kind === "person" ? "👤" : "🔎"}</span>
              {term.count !== null ? `${term.count}× ` : ""}
              {term.label}
              <button
                onClick={() => dismiss(term)}
                aria-label={`Not the ${term.kind} ${term.label}`}
                title={`Search for "${term.matched}" as words instead`}
                style={chipButtonStyle}
              >
                ✕
              </button>
            </span>
          ))}
          {response.residual.trim() !== "" && (
            <span style={residualStyle}>“{response.residual}”</span>
          )}
        </div>
      )}

      {searching && response?.denseUnavailable && (
        <div style={noteStyle}>{response.denseUnavailable}</div>
      )}
      {error && <div style={{ ...noteStyle, color: "#ff9a8a" }}>{error}</div>}
      {searching && !busy && response?.total === 0 && (
        <div style={noteStyle}>
          Nothing matched. Names come from the People view; descriptions need a scene scan.
        </div>
      )}
    </div>
  );
}

const wrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "8px 20px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  background: "#111",
};

const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };

const inputStyle: React.CSSProperties = {
  flex: 1,
  maxWidth: 420,
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 6,
  padding: "6px 10px",
  color: "#eee",
  fontSize: 13,
};

const clearStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#aaa",
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
  padding: "0 2px",
};

const countStyle: React.CSSProperties = { color: "#888", fontSize: 12, whiteSpace: "nowrap" };

const widenStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#ddd",
  borderRadius: 4,
  padding: "3px 10px",
  cursor: "pointer",
  fontSize: 12,
};

const chipRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  alignItems: "center",
};

const personChip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  background: "rgba(120,170,255,0.18)",
  border: "1px solid rgba(120,170,255,0.4)",
  borderRadius: 999,
  padding: "2px 8px",
  fontSize: 12,
  color: "#cfe0ff",
};

/** Objects get the detector's colour, matching the viewer overlay. */
const objectChip: React.CSSProperties = {
  ...personChip,
  background: "rgba(255,190,100,0.16)",
  border: "1px solid rgba(255,190,100,0.4)",
  color: "#ffe6bf",
};

const chipButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  fontSize: 11,
  padding: 0,
  marginLeft: 2,
};

const residualStyle: React.CSSProperties = { fontSize: 12, color: "#999" };

const noteStyle: React.CSSProperties = { fontSize: 12, color: "#ffd86b" };
