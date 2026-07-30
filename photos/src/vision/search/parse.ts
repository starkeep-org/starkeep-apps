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

import { resolveClass } from "../object-classes";

/** A vocabulary a query token can resolve against. Closed and small, by design. */
export type StructuredKind = "person" | "object";

export interface StructuredTerm {
  kind: StructuredKind;
  /**
   * What to match against in the store — a person id, or a COCO class name.
   *
   * For objects this is the class *name* rather than its index, because the index
   * is a model-order detail and the name is what a chip and a URL should carry.
   * `object-classes.ts` maps between them.
   */
  id: string;
  /** What the user typed, for the chip label. */
  matched: string;
  /** The canonical name, which may differ from `matched` in case. */
  label: string;
  /**
   * How many of this class the query asked for, when it said so.
   *
   * `"three dogs"` → 3. Null means "any". §5.4 is emphatic that counting must route
   * to detector counts and never to CLIP, which is weak at it — this field is how
   * that routing is expressed.
   */
  count: number | null;
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
  /**
   * Whether to match COCO classes at all.
   *
   * Off when objects has never been scanned: matching `"dog"` as a class when no
   * photo carries object data turns a query that the dense stage could have
   * answered into a structured filter that matches nothing.
   */
  objects: boolean;
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
 * Words that cannot be searched for on their own.
 *
 * This exists because of a specific bug, worth recording so the list is not trimmed
 * back by someone who thinks it is decoration. When the parse consumes a class or a
 * name it leaves the surrounding function words behind, so `"a boat"` left a residual
 * of `"a"` — and the dense stage duly embedded the article and ranked the whole
 * library against it. `"a boat"` returned four photos where one contains a boat, while
 * `"boats"` (no article to strip) correctly returned one.
 *
 * Includes the meta-words people put in front of a search — `"photos of Alice"` leaves
 * `"photos of"`, which is just as meaningless to embed.
 *
 * Deliberately **only** used to decide whether a residual is searchable at all, never
 * to rewrite it. Stripping these before embedding would be a different and riskier
 * change: the tower handles natural phrasing well, and §5.3's prompt ensembling
 * already exists to smooth over fragments.
 */
const STOPWORDS = new Set([
  // Articles and determiners
  "a", "an", "the", "some", "any", "all", "this", "that", "these", "those",
  // Prepositions and conjunctions
  "of", "on", "in", "at", "with", "and", "or", "to", "from", "for", "by",
  "near", "over", "under", "into", "onto", "about", "as", "is", "are", "was", "were",
  // Words for the medium rather than its content
  "photo", "photos", "picture", "pictures", "image", "images", "pic", "pics",
  "shot", "shots", "snap", "snaps",
  // Words for the act of searching
  "show", "find", "search", "get", "me", "my", "our", "us", "i",
]);

/**
 * The unconsumed tokens, with function words removed.
 *
 * Applied unconditionally, which measurement decided against my expectation. §5.3
 * warns that retrieval is sensitive to phrasing and prefers natural language to
 * fragments, so keeping `"at the beach"` intact looked safer than reducing it to
 * `"beach"`. The scores say otherwise: on real photos the top match barely moves
 * (0.102 → 0.099) while the number of photos clearing the membership floor **halves**
 * (6 → 3). The function words were not aiding discrimination, they were lifting the
 * whole distribution toward a generic "photograph" direction — the same per-query
 * offset that makes `"a lake"` match everything, arriving by a different route.
 *
 * So this is a precision win with no measured cost to the best answer, and it is a
 * bigger one when the parse has consumed something from the middle of a phrase: what
 * it leaves is not a fragment but wreckage, like the `"a on a"` from `"a dog on a
 * boat"`.
 */
function contentResidual(tokens: readonly string[]): string {
  return tokens
    .filter((token) => {
      const key = fold(token);
      return key.length > 0 && !STOPWORDS.has(key);
    })
    .join(" ");
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

  // Names can be several words ("Mary Jane"); COCO classes at most two ("hot dog",
  // "wine glass", "teddy bear"). The window is the longer of the two, so the
  // longest-match loop below covers both vocabularies in one pass.
  const longest = Math.max(2, ...[...byName.values()].map((v) => v.words));
  const terms: StructuredTerm[] = [];
  const consumed = new Array<boolean>(tokens.length).fill(false);

  let at = 0;
  while (at < tokens.length) {
    let matchedLength = 0;
    // Try the longest span that could fit, shrinking until something matches.
    for (let length = Math.min(longest, tokens.length - at); length >= 1; length--) {
      const span = tokens.slice(at, at + length).join(" ");
      const folded = fold(span);

      // People before objects at the same span length. A name is something a human
      // deliberately typed onto a cluster in this library, so it is the stronger
      // claim — and §5.2's chips exist precisely so a wrong person reading (Rose,
      // Daisy, Iris) can be dropped, whereas there is no comparable affordance for
      // recovering a name the parse decided was furniture.
      const person = byName.get(folded);
      if (person) {
        terms.push({
          kind: "person",
          id: person.id,
          matched: span,
          label: person.label,
          count: null,
          from: at,
          to: at + length,
        });
        for (let i = at; i < at + length; i++) consumed[i] = true;
        matchedLength = length;
        break;
      }

      // A span that is nothing but function words can never be a class, however
      // well it resolves. `STOPWORDS` alone does not prevent this: it filters the
      // *residual*, and matching runs first, so "show me photos of a dog" matched
      // `photos` → `Picture/Frame` and searched for framed pictures. Harmless at 80
      // COCO nouns, which contained no word anyone uses to mean "photograph";
      // Objects365 contains several.
      const isFunctionSpan = tokens
        .slice(at, at + length)
        .every((token) => STOPWORDS.has(fold(token)));

      const cls = vocab.objects && !isFunctionSpan ? resolveClass(folded) : null;
      if (cls) {
        // A count immediately before the class — "three dogs", "2 cats". Consumed
        // along with it, so the number does not survive into the residual where it
        // would be a meaningless token for the text tower.
        const countAt = at - 1;
        const count = countAt >= 0 && !consumed[countAt] ? parseCount(tokens[countAt]) : null;
        if (count !== null) consumed[countAt] = true;
        terms.push({
          kind: "object",
          id: cls,
          matched: count !== null ? `${tokens[countAt]} ${span}` : span,
          label: cls,
          count,
          from: count !== null ? countAt : at,
          to: at + length,
        });
        for (let i = at; i < at + length; i++) consumed[i] = true;
        matchedLength = length;
        break;
      }
    }
    at += matchedLength > 0 ? matchedLength : 1;
  }

  return { terms, residual: contentResidual(tokens.filter((_, i) => !consumed[i])), raw: query };
}

/**
 * A leading quantity, as a digit or a small English word.
 *
 * Only up to ten, and deliberately: past that the count is not what the user is
 * really asking (nobody means exactly seventeen chairs), and a general
 * number-word parser would be more machinery than the closed vocabulary of
 * useful answers. `"a"` and `"an"` are *not* counts — "a dog" means any dog, not
 * exactly one, and reading it as `= 1` would exclude every photo with two.
 */
const COUNT_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function parseCount(token: string): number | null {
  const key = fold(token);
  if (key in COUNT_WORDS) return COUNT_WORDS[key];
  if (/^\d{1,2}$/.test(key)) {
    const value = Number(key);
    return value >= 1 && value <= 20 ? value : null;
  }
  return null;
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
    residual: contentResidual(tokens.filter((_, i) => !consumed[i])),
    raw: parsed.raw,
  };
}

/**
 * Stable identity for a chip, so the client can name what it dropped.
 *
 * Excludes the count: dropping `"three dogs"` drops the dog interpretation
 * entirely, and a key that varied with the number would make the dismissal stop
 * applying the moment the user edited it to `"four dogs"` — which is the same
 * mistaken interpretation, not a new one.
 */
export function termKey(term: StructuredTerm): string {
  return `${term.kind}:${term.id}`;
}

