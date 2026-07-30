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
  object: number;
  dense: number;
}

/**
 * `object` sits below `person` because the two are not equally certain. A name was
 * typed by a human onto a cluster; a class came from a detector at a tunable
 * threshold, and §9's own argument for objects is that they cover the slice CLIP is
 * *worst* at rather than that they are more reliable than a name. Still above
 * `dense`, since an exact class match beats a fuzzy resemblance.
 */
export const DEFAULT_WEIGHTS: RankingWeights = { person: 2, object: 1.5, dense: 1 };

/**
 * Raw cosine below which a photo is not a description match at all.
 *
 * **This is a membership test, and it is deliberately absolute** — which §5.3 argued
 * against, on the grounds that cosine is uncalibrated and its useful range shifts per
 * query. That argument is sound and the measurements bear it out: on a real library
 * `"a lake"` spans 0.033–0.076 while `"water"` spans 0.020–0.066, so one constant does
 * behave differently per phrasing.
 *
 * It is used anyway because every *relative* alternative is worse, and measurably so.
 * Min-max normalization and z-scores are both scale-invariant, so they assign the top
 * photo a high score whether or not anything matches: `"a plate of sushi"` on a
 * library containing no food scores every photo **negative**, yet three photos clear
 * a median/MAD z of 1.0. A relative rule cannot express "nothing matched", and that
 * is the one thing a filter must be able to say.
 *
 * What the floor buys, from the same measurements: it excludes the clearly-absent
 * outright (sushi, a subway train — both largely negative). What it cannot do is
 * separate a weak real match from noise, because the model does not separate them
 * either — `"a spaceship"` peaks at 0.037 on a library with no spacecraft while a
 * genuine `"water"` match sits at 0.035. That band is ambiguous in the *model*, not
 * in this code, and no threshold fixes it. §5.4's complementarity argument is the
 * real answer there: the detector knows what a boat is.
 *
 * **The value is chosen by measurement, not taste.** `pnpm vision:tune-floor` sweeps
 * candidate floors over queries with known answers and counts the errors each way. On
 * the library this was first tuned against (7 photos, 12 queries):
 *
 *     floor    false positives   false negatives
 *     0.030          21                 0
 *     0.035           8                 0     ← chosen
 *     0.040           4                 1
 *     0.043           1                 2
 *     0.050           1                 3
 *
 * 0.035 is the largest floor that costs **no recall at all** — a principled criterion
 * rather than a magic number, and the right one while every observed error is a false
 * positive. Push higher only once a false negative is more annoying than a false
 * positive; the table says what that trade costs.
 *
 * **What a floor cannot fix.** `"a lake"` keeps four false positives at *every* floor
 * up to 0.05, because its scores sit high as a block: a query's whole band shifts with
 * its phrasing, so a single constant meets different queries at different points in
 * their distributions. That is §5.3's objection, reproduced rather than argued.
 *
 * Two things measured and rejected on the way here, recorded so they are not retried:
 *
 *   - **Scale-free rules** (min-max, median/MAD z-scores) cannot express "nothing
 *     matched" at all — `"a plate of sushi"` scores every photo *negative* on a library
 *     with no food, yet three clear a z of 1.0.
 *   - **Centering the gallery** (subtracting the mean image embedding to remove the
 *     per-query offset) made things *worse* on this data: sushi went from a correct
 *     −0.001 to +0.028, overlapping real matches. With a small library whose photos all
 *     share a subject, the mean *is* that subject, so removing it flatters anything
 *     unlike it. Worth revisiting at thousands of photos, where the mean means
 *     something.
 */
export const DEFAULT_DENSE_FLOOR = 0.035;

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

export interface RankingOptions {
  weights?: RankingWeights;
  /** Raw-cosine membership floor for description matches. */
  denseFloor?: number;
}

/**
 * Decide membership, then fuse and order the survivors.
 *
 * **Membership and ranking are separate steps, and conflating them was a real bug.**
 * The previous version let min-max normalization decide both: the pool minimum
 * normalizes to exactly 0, scores 0, and was dropped — so a description query over a
 * pool of *every indexed photo* always returned `poolSize − 1` results, whatever was
 * typed and whether or not anything matched. On a small library that is almost the
 * whole library; on a large one it is silently always exactly `limit`. Either way
 * there was no reachable "nothing matched".
 *
 * A candidate is admitted if it carries **any exact signal** (a person or a class —
 * those are lookups, not similarities) **or** a raw cosine at or above the floor.
 * Normalization then happens over the admitted pool and only sets the *weighting* of
 * the description term against the structured ones, which is all it was ever suited
 * for.
 *
 * Normalization is the part that must not be skipped. Raw cosine sits in a
 * narrow, uncalibrated, query-dependent band — for SigLIP typically well above
 * zero and spanning a fraction of a point — while `match_t` is 0 or 1. Summing
 * them directly makes the weight do all the work and impossible to tune. Doing it
 * per query rather than globally is what adapts to wherever the band happens to
 * sit for this particular phrasing (§5.3).
 *
 * Exactness for pure-structured queries falls out of the same rule: `"photos of
 * Alice"` has no residual, so `dense` is null throughout and only photos carrying the
 * exact match are admitted — a filter, with no special case for it.
 */
export function rankCandidates(
  candidates: readonly Candidate[],
  options: RankingWeights | RankingOptions = {},
): ScoredResult[] {
  // Accepts bare weights for the callers that predate the options object.
  const opts: RankingOptions = "dense" in options ? { weights: options } : options;
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const floor = opts.denseFloor ?? DEFAULT_DENSE_FLOOR;

  const admitted = candidates.filter(
    (c) => c.matched.length > 0 || (c.dense !== null && c.dense >= floor),
  );

  // Normalized over the *admitted* pool, not every candidate: including rejects would
  // let a photo that failed the floor set the bottom of the range and compress
  // everything that passed it into the top of the scale.
  const dense = admitted.map((c) => c.dense).filter((d): d is number => d !== null);
  const lowest = dense.length > 0 ? Math.min(...dense) : 0;
  const highest = dense.length > 0 ? Math.max(...dense) : 0;
  const span = highest - lowest;

  const scored: ScoredResult[] = [];
  for (const candidate of admitted) {
    let structured = 0;
    for (const term of candidate.matched) structured += weightFor(term, weights);

    // A degenerate span — one candidate, or every cosine identical — normalizes to
    // 1 rather than dividing by zero. With nothing to separate, every photo is
    // equally good on the dense axis, and 1 keeps the structured terms deciding
    // the order instead of erasing the dense contribution entirely.
    const normalized =
      candidate.dense === null ? null : span > 1e-9 ? (candidate.dense - lowest) / span : 1;

    // No `score <= 0` drop: membership was decided above, and using the score for it
    // is what discarded the weakest admitted match on every query.
    scored.push({
      recordId: candidate.recordId,
      score: structured + (normalized === null ? 0 : weights.dense * normalized),
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
    case "object":
      return weights.object;
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
