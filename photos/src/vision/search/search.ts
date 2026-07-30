/**
 * Search: query string → ordered results (plan §5, end to end).
 *
 * Orchestrates the three pieces that each live elsewhere — the lexical parse
 * (`parse.ts`), the dense stage (the query worker plus the compacted index), and
 * additive fusion (`ranking.ts`). Kept separate from the route so the pipeline is
 * testable without a `Request`.
 *
 * **Hybrid, not one vector space** (§4). Alice is an exact lookup against a name a
 * human typed on a cluster; "at the beach" is a cosine against a language-aligned
 * embedding. Forcing identity into the dense path would make an exact signal
 * fuzzy, which is strictly worse — and the face embedding being *also* 512-d makes
 * that mistake fail silently, so the two never meet.
 */

import { readAllFaceSidecars } from "../sidecars";
import { readPeople } from "../people";
import { readSceneIndex, scoreAgainstIndex } from "../scene-index";
import { embedQueries } from "./query-controller";
import { parseQuery, termKey, withoutTerms, type ParsedQuery, type StructuredTerm } from "./parse";
import {
  bandResults,
  rankCandidates,
  DEFAULT_WEIGHTS,
  type Candidate,
  type RankingWeights,
  type ScoredResult,
} from "./ranking";

export interface SearchOptions {
  /** Chip keys (`person:<id>`) the user has dismissed — §5.2. */
  dropped?: ReadonlySet<string>;
  weights?: RankingWeights;
  /** How many results to return. §5.3: top-k with "show more", never a threshold. */
  limit?: number;
}

export interface SearchResponse {
  raw: string;
  /** The parse, for rendering chips. */
  terms: Array<StructuredTerm & { key: string }>;
  residual: string;
  results: ScoredResult[];
  /** The same results grouped by which structured terms fired (§5.1). */
  bands: Array<{ terms: StructuredTerm[]; results: ScoredResult[] }>;
  /** Total before `limit`, so the UI can offer "show more" honestly. */
  total: number;
  /** Set when the dense stage could not run, so the UI can say why. */
  denseUnavailable: string | null;
}

export const DEFAULT_SEARCH_LIMIT = 60;

/**
 * §5.3's prompt handling: average the raw residual with `"a photo of {residual}"`.
 *
 * Standard prompt ensembling, one extra text encode. A bare fragment like
 * `"at the beach"` is not what a retrieval model saw in training, but a blind
 * template makes `"a photo of at the beach"` — ungrammatical — so averaging the
 * two hedges rather than committing to either. §11 lists this as a prime candidate
 * for iteration, which is why it is one small function.
 */
export function promptVariants(residual: string): string[] {
  return [residual, `a photo of ${residual}`];
}

function meanUnit(vectors: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(vectors[0].length);
  for (const v of vectors) {
    for (let i = 0; i < out.length; i++) out[i] += v[i];
  }
  let sum = 0;
  for (const v of out) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < out.length; i++) out[i] /= norm;
  }
  return out;
}

/**
 * Which records carry a face assigned to each matched person.
 *
 * Folds the face store, which §5.5 warns against doing *per query* for
 * embeddings — but this reads assignments, not vectors, and only when a person
 * term actually parsed. A query with no name never touches it. If it becomes a
 * cost, the fix is a person→records map maintained beside `people.json`, not a
 * different search design.
 */
function matchPeople(terms: readonly StructuredTerm[]): Map<string, StructuredTerm[]> {
  const wanted = new Map<string, StructuredTerm>();
  for (const term of terms) {
    if (term.kind === "person") wanted.set(term.id, term);
  }
  const hits = new Map<string, StructuredTerm[]>();
  if (wanted.size === 0) return hits;

  for (const [recordId, sidecar] of readAllFaceSidecars()) {
    for (const face of sidecar.faces) {
      const term = face.personId ? wanted.get(face.personId) : undefined;
      if (!term) continue;
      const existing = hits.get(recordId);
      if (existing) {
        // One term per record even if the person appears twice — `match_t` is
        // binary (§5.1), so a crowd shot must not outscore a portrait.
        if (!existing.includes(term)) existing.push(term);
      } else {
        hits.set(recordId, [term]);
      }
    }
  }
  return hits;
}

export function parseFor(query: string, dropped?: ReadonlySet<string>): ParsedQuery {
  const people = new Map<string, string>();
  for (const person of readPeople()) {
    // Only *named* clusters are matchable: an unnamed cluster has no string a
    // human could have typed.
    if (person.name.trim() !== "") people.set(person.id, person.name.trim());
  }
  const parsed = parseQuery(query, { people });
  return dropped && dropped.size > 0 ? withoutTerms(parsed, dropped) : parsed;
}

export async function search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const parsed = parseFor(query, options.dropped);
  const peopleHits = matchPeople(parsed.terms);

  const dense = new Map<string, number>();
  let denseUnavailable: string | null = null;

  if (parsed.residual.trim() !== "") {
    const index = readSceneIndex();
    if (!index) {
      // Derived and disposable, so "no index" is a state to explain rather than an
      // error: scene has not been scanned, or the model changed and it is waiting
      // to be rebuilt. Structured terms still work meanwhile.
      denseUnavailable =
        "no scene embeddings yet — enable scene in Settings and run a scan to search by description";
    } else {
      const vectors = await embedQueries(promptVariants(parsed.residual));
      const query = meanUnit(vectors);
      for (const [recordId, score] of scoreAgainstIndex(index, query)) {
        dense.set(recordId, score);
      }
    }
  }

  // Every record carrying *either* signal is a candidate. Nothing is excluded for
  // lacking one — that is what makes the additive invariant hold, and what lets a
  // photo where Alice is present but undetected still land in the beach band
  // (§5.1, which is also why no separate backfill step exists).
  const recordIds = new Set<string>([...peopleHits.keys(), ...dense.keys()]);
  const candidates: Candidate[] = [];
  for (const recordId of recordIds) {
    candidates.push({
      recordId,
      matched: peopleHits.get(recordId) ?? [],
      dense: dense.has(recordId) ? (dense.get(recordId) as number) : null,
    });
  }

  const ranked = rankCandidates(candidates, options.weights ?? DEFAULT_WEIGHTS);
  const limited = ranked.slice(0, limit);

  return {
    raw: parsed.raw,
    terms: parsed.terms.map((term) => ({ ...term, key: termKey(term) })),
    residual: parsed.residual,
    results: limited,
    bands: bandResults(limited),
    total: ranked.length,
    denseUnavailable,
  };
}
