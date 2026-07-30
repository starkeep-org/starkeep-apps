/**
 * Score and order results (plan §5.1).
 *
 * The invariant the whole design serves:
 *
 *     score(Alice ∧ beach) > score(Alice) , score(beach)
 *
 * A photo carrying *both* signals must outrank either alone. That makes "hard
 * filter versus soft boost" a false choice — a hard filter is just the limiting
 * case of a large structured weight — so fusion is additive and nothing is ever
 * excluded for lacking one signal.
 *
 *     score = Σ w_t · match_t   +   w_dense · normalized_dense
 *
 * No ONNX here. The dense scores arrive already computed; this module only fuses.
 */

import type { StructuredTerm } from "./parse";

/**
 * The tunable weights, in one place.
 *
 * §11 lists these as settle-by-trying, and the point of keeping them here is that
 * tuning them never touches retrieval code. The ratio is what matters, not the
 * magnitudes: `w_person / w_dense` sets how sharply structured matches separate
 * into bands. At 2:1 everything with Alice sits above everything without, ordered
 * within each band by beach-ness; raising it approaches a hard filter, lowering it
 * blends the bands.
 */
export interface RankingWeights {
  person: number;
  dense: number;
}

export const DEFAULT_WEIGHTS: RankingWeights = { person: 2, dense: 1 };

export interface Candidate {
  recordId: string;
  /** Which structured terms this photo satisfies. */
  matched: StructuredTerm[];
  /** Raw cosine against the image embedding, or null when there is no residual. */
  dense: number | null;
}

export interface ScoredResult {
  recordId: string;
  score: number;
  /** The structured contribution, for explaining a result and for banding. */
  structured: number;
  /** The normalized dense contribution in [0, 1], or null. */
  dense: number | null;
  matched: StructuredTerm[];
}

/**
 * Min-max normalize the dense scores **across this query's pool**, then fuse.
 *
 * Normalization is the part that must not be skipped. Raw cosine sits in a
 * narrow, uncalibrated, query-dependent band — for SigLIP typically well above
 * zero and spanning a fraction of a point — while `match_t` is 0 or 1. Summing
 * them directly makes the weight do all the work and impossible to tune. Doing it
 * per query rather than globally is what adapts to wherever the band happens to
 * sit for this particular phrasing (§5.3).
 *
 * Dropping everything that scores zero preserves exactness for pure-structured
 * queries: `"photos of Alice"` has no residual, so there is no dense term, and
 * everything that matched nothing is excluded — which is exactly a filter, with no
 * special case for it.
 *
 * One consequence worth naming rather than discovering: min-max normalization puts
 * the pool's dense *minimum* at 0, so a dense query silently drops its single
 * worst match. Over a real library the pool is every indexed photo, so that is one
 * photo out of thousands and beneath notice — but it is why a two-candidate pool
 * returns one result, which looks like a bug in a test and is not.
 */
export function rankCandidates(
  candidates: readonly Candidate[],
  weights: RankingWeights = DEFAULT_WEIGHTS,
): ScoredResult[] {
  const dense = candidates.map((c) => c.dense).filter((d): d is number => d !== null);
  const lowest = dense.length > 0 ? Math.min(...dense) : 0;
  const highest = dense.length > 0 ? Math.max(...dense) : 0;
  const span = highest - lowest;

  const scored: ScoredResult[] = [];
  for (const candidate of candidates) {
    let structured = 0;
    for (const term of candidate.matched) structured += weightFor(term, weights);

    // A degenerate span — one candidate, or every cosine identical — normalizes to
    // 1 rather than dividing by zero. With nothing to separate, every photo is
    // equally good on the dense axis, and 1 keeps the structured terms deciding
    // the order instead of erasing the dense contribution entirely.
    const normalized =
      candidate.dense === null ? null : span > 1e-9 ? (candidate.dense - lowest) / span : 1;

    const score = structured + (normalized === null ? 0 : weights.dense * normalized);
    if (score <= 0) continue;
    scored.push({
      recordId: candidate.recordId,
      score,
      structured,
      dense: normalized,
      matched: candidate.matched,
    });
  }

  // Descending by score, then by record id so equal scores order stably rather
  // than by whatever the store happened to list first.
  scored.sort((a, b) => b.score - a.score || (a.recordId < b.recordId ? -1 : 1));
  return scored;
}

function weightFor(term: StructuredTerm, weights: RankingWeights): number {
  switch (term.kind) {
    case "person":
      return weights.person;
  }
}

/**
 * Group results into the bands the weights already produce (§5.1).
 *
 * Not a second scoring pass — the bands *fall out* of the weight ratio, and this
 * only labels them so the UI can render "Alice at the beach" / "Alice" /
 * "at the beach" as sections if it wants to. §5.1 calls that a refinement and
 * plain score ordering the thing to ship first, so the route returns both and the
 * client decides.
 *
 * Keyed by which structured terms fired, because that is what distinguishes the
 * bands — two photos of Alice sit in the same band whatever their beach-ness.
 */
export function bandResults(results: readonly ScoredResult[]): Array<{
  /** Term keys that fired, in query order; empty means dense-only. */
  terms: StructuredTerm[];
  results: ScoredResult[];
}> {
  const bands = new Map<string, { terms: StructuredTerm[]; results: ScoredResult[] }>();
  for (const result of results) {
    const key = result.matched.map((t) => `${t.kind}:${t.id}`).join("+");
    let band = bands.get(key);
    if (!band) {
      band = { terms: result.matched, results: [] };
      bands.set(key, band);
    }
    band.results.push(result);
  }
  // Bands are already encountered in descending score order, since `results` is
  // sorted and a band's structured contribution is constant within it.
  return [...bands.values()];
}
