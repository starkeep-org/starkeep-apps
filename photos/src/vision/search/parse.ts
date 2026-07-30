/**
 * Query parsing: split `"Alice at the beach"` into structured terms and a dense
 * residual (plan §5).
 *
 * Longest-match n-grams against the closed vocabularies — person names today,
 * COCO classes and the scene vocabulary as they arrive. Tractable, deterministic,
 * local, and needs no model, which is why §5 says to start here.
 *
 * **Not an LLM, deliberately.** An LLM via the capability broker would read intent
 * better, but note what a query contains: the names of people in the user's
 * library. Vision state is local-only by explicit design (§2), so routing queries
 * off-device is a real disclosure needing its own opt-in on the `publishLabels`
 * model — not a default, and not in this phase.
 *
 * No ONNX and no engine imports: the parse runs in the route, not the worker.
 * Only the *dense* half needs the text tower.
 */

/** A vocabulary a query token can resolve against. Closed and small, by design. */
export type StructuredKind = "person";

export interface StructuredTerm {
  kind: StructuredKind;
  /** What to match against in the store — a person id, not a name. */
  id: string;
  /** What the user typed, for the chip label. */
  matched: string;
  /** The canonical name, which may differ from `matched` in case. */
  label: string;
  /** Token span in the tokenized query, so removing a chip can re-derive the residual. */
  from: number;
  to: number;
}

export interface ParsedQuery {
  /** Everything the parse recognized, in query order. */
  terms: StructuredTerm[];
  /** What is left for the dense stage — may be empty. */
  residual: string;
  /** The raw query, unchanged. */
  raw: string;
}

export interface Vocabularies {
  /** `id → name`, from `people.json`. Only named clusters are matchable. */
  people: ReadonlyMap<string, string>;
}

/**
 * Split on whitespace, keeping the original spelling of each token.
 *
 * Punctuation is deliberately *not* stripped: it belongs to the residual, where
 * the text tower handles it far better than a rule would, and stripping it would
 * make `"don't"` unmatchable against a name that contains an apostrophe.
 */
function tokenize(query: string): string[] {
  return query.split(/\s+/).filter((t) => t.length > 0);
}

/** Case- and punctuation-insensitive key for vocabulary lookup. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Longest match first, so `"hot dog"` beats `"dog"` and `"Mary Jane"` beats
 * `"Mary"`.
 *
 * The concrete failure this avoids: a library with both a "Mary" and a
 * "Mary Jane" would otherwise match the shorter name and leave `"Jane"` in the
 * residual, which reads as a plausible scene word and quietly poisons the dense
 * ranking.
 *
 * Names are matched only when the cluster has been named — an unnamed cluster has
 * no string a human could have typed.
 */
export function parseQuery(query: string, vocab: Vocabularies): ParsedQuery {
  const tokens = tokenize(query);
  const byName = new Map<string, { id: string; label: string; words: number }>();
  for (const [id, name] of vocab.people) {
    const key = fold(name);
    if (key.length === 0) continue;
    // First writer wins on a collision: two clusters sharing a name are
    // indistinguishable from a query, and picking one arbitrarily at least keeps
    // the parse deterministic. Chips let the user drop it if it is the wrong one.
    if (!byName.has(key)) {
      byName.set(key, { id, label: name, words: key.split(" ").length });
    }
  }

  const longest = Math.max(1, ...[...byName.values()].map((v) => v.words));
  const terms: StructuredTerm[] = [];
  const consumed = new Array<boolean>(tokens.length).fill(false);

  let at = 0;
  while (at < tokens.length) {
    let matchedLength = 0;
    // Try the longest span that could fit, shrinking until something matches.
    for (let length = Math.min(longest, tokens.length - at); length >= 1; length--) {
      const span = tokens.slice(at, at + length).join(" ");
      const hit = byName.get(fold(span));
      if (!hit) continue;
      terms.push({
        kind: "person",
        id: hit.id,
        matched: span,
        label: hit.label,
        from: at,
        to: at + length,
      });
      for (let i = at; i < at + length; i++) consumed[i] = true;
      matchedLength = length;
      break;
    }
    at += matchedLength > 0 ? matchedLength : 1;
  }

  const residual = tokens.filter((_, i) => !consumed[i]).join(" ");
  return { terms, residual, raw: query };
}

/**
 * Re-derive a parse with some interpretations dropped (§5.2's ✕ on a chip).
 *
 * The dropped span returns to the residual rather than vanishing: removing the
 * person interpretation of `"rose at the beach"` should search for *rose* the
 * flower, not for `"at the beach"` alone. That is the whole point of the chip —
 * the parse was wrong, not the word.
 */
export function withoutTerms(parsed: ParsedQuery, dropped: ReadonlySet<string>): ParsedQuery {
  const kept = parsed.terms.filter((term) => !dropped.has(termKey(term)));
  if (kept.length === parsed.terms.length) return parsed;

  const tokens = tokenize(parsed.raw);
  const consumed = new Array<boolean>(tokens.length).fill(false);
  for (const term of kept) {
    for (let i = term.from; i < term.to; i++) consumed[i] = true;
  }
  return {
    terms: kept,
    residual: tokens.filter((_, i) => !consumed[i]).join(" "),
    raw: parsed.raw,
  };
}

/** Stable identity for a chip, so the client can name what it dropped. */
export function termKey(term: StructuredTerm): string {
  return `${term.kind}:${term.id}`;
}
