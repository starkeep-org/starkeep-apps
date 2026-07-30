import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchPhotoTags,
  savePhotoTags,
  VISION_UNAVAILABLE,
  type PhotoTagView,
} from "../../../lib/vision-client";

/**
 * One photo's tags, editable (plan §7).
 *
 * Renders nothing when the vision routes answer 501 — a cloud-served Photos has no
 * embeddings to score against.
 *
 * With the vocabulary empty — its current parked state — this is simply a manual tag
 * editor, and still a useful one: user tags never depended on the vocabulary, and
 * they are the only thing §7 publishes anyway.
 *
 * **Suggestions and user tags look different, on purpose.** A suggestion is an
 * uncalibrated cosine that cleared an arbitrary bar; a confirmed or typed tag is a
 * human's judgement. §7 turns on that distinction — only the latter is publishable,
 * so a UI that rendered them identically would make "did anyone actually agree with
 * this?" unanswerable.
 *
 * **Removing a suggestion persists a negative.** That is the part that is easy to
 * get wrong and impossible to notice for a while: without it the next scoring
 * re-derives the tag and it silently returns. So ✕ on a suggestion adds it to
 * `removed`, not merely to a local filter.
 */

interface PhotoTagsProps {
  recordId: string;
  visible: boolean;
}

export function PhotoTags({ recordId, visible }: PhotoTagsProps) {
  const [tags, setTags] = useState<PhotoTagView[] | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{ tag: string; score: number }>>([]);
  const [edits, setEdits] = useState<{ added: string[]; removed: string[] }>({
    added: [],
    removed: [],
  });
  const [described, setDescribed] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchPhotoTags(recordId);
      if (result === VISION_UNAVAILABLE) {
        setUnavailable(true);
        return;
      }
      setTags(result.tags);
      setSuggestions(result.suggestions);
      setEdits(result.edits);
      setDescribed(result.described);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [recordId]);

  useEffect(() => {
    setTags(null);
    if (!visible) return;
    void load();
  }, [visible, load]);

  const save = async (next: { added: string[]; removed: string[] }) => {
    setBusy(true);
    setError(null);
    try {
      const result = await savePhotoTags(recordId, next);
      if (result === VISION_UNAVAILABLE) {
        setUnavailable(true);
        return;
      }
      setTags(result.tags);
      setSuggestions(result.suggestions);
      setEdits(result.edits);
      setDescribed(result.described);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Keep a suggestion: move it into `added` so it becomes authoritative.
   *
   * Not a no-op even though the tag is already showing — a suggestion survives only
   * as long as it keeps scoring above the threshold, and a vocabulary edit or a
   * model swap can take it away. Confirming is what makes it permanent, and what
   * makes it publishable.
   */
  const confirm = (tag: string) =>
    void save({
      added: [...new Set([...edits.added, tag])],
      removed: edits.removed.filter((t) => t !== tag),
    });

  /** Remove: persist a negative, or withdraw an addition. */
  const remove = (tag: string, source: PhotoTagView["source"]) =>
    void save({
      added: edits.added.filter((t) => t !== tag),
      // A tag the user typed needs no negative — dropping it from `added` is enough,
      // and adding a spurious `removed` entry would block the vocabulary from ever
      // suggesting it later.
      removed: source === "added" ? edits.removed : [...new Set([...edits.removed, tag])],
    });

  const add = () => {
    const tag = draft.trim();
    if (tag === "") return;
    setDraft("");
    void save({
      added: [...new Set([...edits.added, tag])],
      removed: edits.removed.filter((t) => t !== tag),
    });
  };

  const restore = (tag: string) =>
    void save({ added: edits.added, removed: edits.removed.filter((t) => t !== tag) });

  /**
   * Whether automatic suggestions are even on the table.
   *
   * With the vocabulary parked (empty), this is a manual tag editor — which works
   * fine, since user tags never depended on the vocabulary — and saying "nothing
   * scored above the threshold" would blame a threshold for the absence of a list.
   */
  const suggestionsPossible = tags !== null && (tags.length > 0 || suggestions.length > 0);

  const sorted = useMemo(() => {
    if (!tags) return [];
    // User tags first, then suggestions by score — the human's answers should not be
    // buried under the model's guesses.
    const rank = { added: 0, confirmed: 1, suggested: 2 } as const;
    return [...tags].sort(
      (a, b) => rank[a.source] - rank[b.source] || (b.score ?? 1) - (a.score ?? 1),
    );
  }, [tags]);

  if (unavailable) return null;

  return (
    <div style={wrapStyle} data-testid="photo-tags">
      <div style={headingStyle}>Tags</div>

      {tags === null && !error && <div style={noteStyle}>Loading…</div>}

      {tags !== null && (
        <>
          <div style={chipRowStyle}>
            {sorted.map((tag) => (
              <span
                key={tag.tag}
                data-testid={`tag-${tag.source}`}
                style={tag.source === "suggested" ? suggestedChipStyle : userChipStyle}
                title={
                  tag.score !== null
                    ? `${tag.source} · similarity ${tag.score.toFixed(3)}`
                    : tag.source
                }
              >
                {tag.tag}
                {tag.source === "suggested" && (
                  <button
                    onClick={() => confirm(tag.tag)}
                    disabled={busy}
                    aria-label={`Keep ${tag.tag}`}
                    title="Keep this tag"
                    style={chipButtonStyle}
                  >
                    ✓
                  </button>
                )}
                <button
                  onClick={() => remove(tag.tag, tag.source)}
                  disabled={busy}
                  aria-label={`Remove ${tag.tag}`}
                  style={chipButtonStyle}
                >
                  ✕
                </button>
              </span>
            ))}
            {sorted.length === 0 && (
              <span style={noteStyle}>
                {!described
                  ? "Not described yet — run a scene scan."
                  : suggestionsPossible
                    ? "Nothing scored above the threshold."
                    : "No tags yet."}
              </span>
            )}
          </div>

          <div style={addRowStyle}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder="Add a tag"
              aria-label="Add a tag"
              disabled={busy}
              style={inputStyle}
            />
            <button onClick={add} disabled={busy || draft.trim() === ""} style={buttonStyle}>
              Add
            </button>
          </div>

          {edits.removed.length > 0 && (
            <div style={noteStyle}>
              Hidden:{" "}
              {edits.removed.map((tag) => (
                <button
                  key={tag}
                  onClick={() => restore(tag)}
                  disabled={busy}
                  title="Allow this tag to be suggested again"
                  style={restoreStyle}
                >
                  {tag} ↩
                </button>
              ))}
            </div>
          )}

          {suggestions.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ ...noteStyle, cursor: "pointer" }}>
                Near misses ({suggestions.length})
              </summary>
              <div style={chipRowStyle}>
                {suggestions.map((entry) => (
                  <button
                    key={entry.tag}
                    onClick={() => confirm(entry.tag)}
                    disabled={busy}
                    title={`similarity ${entry.score.toFixed(3)} — below the threshold`}
                    style={nearMissStyle}
                  >
                    + {entry.tag}
                  </button>
                ))}
              </div>
            </details>
          )}
        </>
      )}

      {error && <div style={{ ...noteStyle, color: "#f88" }}>{error}</div>}
    </div>
  );
}

const wrapStyle: React.CSSProperties = {
  marginTop: 12,
  paddingTop: 12,
  borderTop: "1px solid rgba(255,255,255,0.12)",
  fontSize: 13,
};

const headingStyle: React.CSSProperties = {
  fontWeight: 600,
  marginBottom: 8,
  color: "#ddd",
};

const noteStyle: React.CSSProperties = { color: "#999", fontSize: 12, marginTop: 6 };

const chipRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  alignItems: "center",
};

/** A human's judgement: solid. */
const userChipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  background: "rgba(120,210,255,0.18)",
  border: "1px solid rgba(120,210,255,0.45)",
  borderRadius: 999,
  padding: "2px 8px",
  color: "#cfefff",
};

/** The model's guess: dashed, because it is a suggestion and not a fact. */
const suggestedChipStyle: React.CSSProperties = {
  ...userChipStyle,
  background: "rgba(255,255,255,0.05)",
  border: "1px dashed rgba(255,255,255,0.3)",
  color: "#bbb",
};

const chipButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  fontSize: 11,
  padding: 0,
  lineHeight: 1,
};

const addRowStyle: React.CSSProperties = { display: "flex", gap: 6, marginTop: 8 };

const inputStyle: React.CSSProperties = {
  flex: 1,
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 4,
  padding: "4px 8px",
  color: "#eee",
  fontSize: 13,
};

const buttonStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.12)",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#ddd",
  borderRadius: 4,
  padding: "4px 10px",
  cursor: "pointer",
  fontSize: 13,
};

const restoreStyle: React.CSSProperties = {
  ...chipButtonStyle,
  fontSize: 12,
  marginLeft: 6,
  textDecoration: "underline",
};

const nearMissStyle: React.CSSProperties = {
  ...suggestedChipStyle,
  cursor: "pointer",
  opacity: 0.75,
};
