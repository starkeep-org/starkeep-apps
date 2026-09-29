/**
 * The platform's stand-in summary, as the candidate list Photos resolves over.
 *
 * Every listed original in a stand-in category carries `stand_ins`: the sizes
 * that exist or should, and where each sits on the node that answered. Photos'
 * resolution — which rung *should* answer a request, and what to paint
 * meanwhile — was written against a list of derived children with a long edge,
 * a rung name and a URL, and that shape is still the right one to resolve
 * over. So this is the one place the summary is read, and everything past it
 * is unchanged.
 *
 * Posters and skims are not in the summary: they are derived records rather
 * than stand-ins, so Photos still asks for them as `variant` candidates by its
 * own `photos/derived` label, and they are appended as they arrive.
 */

import { classForStandIn } from "./ladder";

/** One size of an original, as `stand_ins.sizes[]` carries it. */
export interface WireStandInSize {
  readonly fidelity: number;
  readonly role: "canonical" | "smaller" | "original";
  readonly record_id: string | null;
  readonly type: string | null;
  readonly size_bytes: number | null;
  readonly placement: "here" | "cloud" | "missing";
  readonly url?: string;
}

export interface WireStandInSummary {
  readonly category: string;
  readonly fidelity: number | null;
  readonly status: "archivable" | "self-canonical" | "video-below-floor" | "fidelity-unknown";
  readonly top: number | null;
  readonly sizes: readonly WireStandInSize[];
}

export type UrlLifetime = { kind: "expires"; expires_at: string } | { kind: "non-expiring" };

/** A derived child as Photos resolves over it. */
export interface VariantCandidate {
  id: string;
  type: string;
  width: number;
  height: number;
  long_edge: number;
  /** The rung this is — a stand-in's name in Photos' ladder, or `original`. */
  label_value: string;
  available_here: boolean;
  url?: string;
  url_lifetime?: UrlLifetime;
}

export interface StandInRecord {
  id: string;
  type?: string;
  mime_type?: string | null;
  metadata?: { width?: number | null; height?: number | null } | null;
  stand_ins?: WireStandInSummary;
  variant_candidates?: VariantCandidate[];
}

/**
 * The rung name a self-canonical original answers as. Not a class of the
 * ladder: the original is what the ladder is derived *from*, and it appears
 * here only because, for a small enough original, it is the best size there is.
 */
export const ORIGINAL_RUNG = "original";

/**
 * Formats a browser paints without help. A self-canonical HEIC original is the
 * top of its record's sizes and still cannot be shown in most browsers, so it
 * is left out and the record falls back to its largest stand-in — the
 * limitation the design names rather than solves.
 */
const BROWSER_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);

/**
 * How long a summary URL is trusted. Both data servers sign stand-in URLs for
 * six hours; an hour less leaves room for clock skew and a slow page.
 */
const URL_TRUST_MS = 5 * 60 * 60 * 1000;

export function candidatesFromStandIns(
  record: Omit<StandInRecord, "variant_candidates">,
  now = Date.now(),
): VariantCandidate[] {
  const summary = record.stand_ins;
  if (!summary) return [];
  const category = summary.category === "video" ? "video" : summary.category === "image" ? "image" : null;
  if (!category) return [];
  const width = record.metadata?.width ?? 0;
  const height = record.metadata?.height ?? 0;

  const out: VariantCandidate[] = [];
  for (const size of summary.sizes) {
    if (size.placement === "missing" || !size.record_id || !size.type) continue;
    if (size.role === "original" && !BROWSER_IMAGE_TYPES.has(size.type)) continue;
    const label =
      size.role === "original" ? ORIGINAL_RUNG : classForStandIn(category, size.role, size.fidelity);
    // A stand-in at a standard size this ladder does not name is another
    // app's; Photos neither resolves to it nor counts it as a rung it has.
    if (!label) continue;
    out.push({
      id: size.record_id,
      type: size.type,
      ...dimensionsAt(size.fidelity, width, height),
      long_edge: size.fidelity,
      label_value: label,
      available_here: size.placement === "here",
      ...(size.url
        ? {
            url: size.url,
            url_lifetime: { kind: "expires" as const, expires_at: new Date(now + URL_TRUST_MS).toISOString() },
          }
        : {}),
    });
  }
  return out;
}

/**
 * The record with its stand-ins folded into `variant_candidates`, ahead of any
 * derived ones. Generic over the caller's own narrower candidate shape, which
 * every {@link VariantCandidate} satisfies.
 */
export function withStandInCandidates<
  T extends Omit<StandInRecord, "variant_candidates"> & { variant_candidates?: readonly unknown[] },
>(record: T, now = Date.now()): T {
  return {
    ...record,
    variant_candidates: [...candidatesFromStandIns(record, now), ...(record.variant_candidates ?? [])],
  } as T;
}

/**
 * A stand-in's dimensions, from its long edge and the original's aspect ratio.
 *
 * A stand-in carries no metadata row — its fidelity is its size — and every
 * stand-in keeps its original's aspect ratio, so the short edge follows. With
 * no stored dimensions the stand-in is reported square, which only a caller
 * laying out an unmeasured original ever sees.
 */
function dimensionsAt(longEdge: number, width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: longEdge, height: longEdge };
  if (width >= height) return { width: longEdge, height: Math.max(1, Math.round((longEdge * height) / width)) };
  return { width: Math.max(1, Math.round((longEdge * width) / height)), height: longEdge };
}
