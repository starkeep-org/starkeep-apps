/**
 * Which rung a record *should* have for a requested size, and whether it has it
 * yet.
 *
 * ## Why this is a Photos question and not a platform one
 *
 * Naming the ideal rung requires knowing that 540 px resolves to `image-medium`
 * and that `image-medium` clamps to 1280 or to the source's long edge,
 * whichever is smaller. That is the ladder, and the ladder is Photos'. The data
 * server answers one app-agnostic question — what derived children does this
 * record have, and how big is each — and this file turns that into the answer
 * an app that owns a ladder actually wanted.
 *
 * ## What the old answer could not express
 *
 * Resolution alone returns the rung that best fits, and a client holding one
 * cannot tell three different situations apart: the rung it wanted exists, the
 * rung it wanted is still deriving, and the rung it wanted is never going to
 * exist because this record's ladder stops lower. Those need different pixels
 * on screen — a picture, a placeholder that will improve, and a picture that is
 * as good as this photo gets — and a bare "here is 400 px" is the same shape
 * for all three.
 *
 * So each requested target gets **the ideal**, always, flagged available or
 * not, plus **at most one fallback** to paint meanwhile.
 *
 * ## The fallback is always *below* the ideal
 *
 * A rung above the ideal is by definition more bytes than the ideal, so
 * reaching for one means fetching the expensive thing first and the correct
 * thing second — the opposite of what progressive presentation is for. Serving
 * 400 now and 1280 shortly is cheap-then-right; serving 2560 now and 1280
 * shortly is expensive-then-redundant.
 *
 * It is also actively harmful under Intelligent-Tiering, where reading a large
 * object promotes it back to Frequent Access for thirty days. A rule that
 * reached upward for a placeholder would undo the tiering on exactly the large
 * renditions tiering exists to make cheap, and would do it on a cold library,
 * where reaching upward is most likely to fire.
 *
 * A larger-than-ideal rendition that happens to exist is simply not consulted
 * for this target. It is the ideal for some larger target, and the viewer gets
 * it there.
 */

import {
  applicableStillClasses,
  renditionLongEdge,
  type StillClassSpec,
} from "./ladder";

/** Why an ideal rung is not available. */
export type RenditionState =
  /** Nothing is wrong; it has not been derived yet. */
  | "pending"
  /**
   * The node answering this request cannot decode the source at all, so it
   * will never produce this rung. Somewhere else can — which is what makes
   * this a temporary, self-healing condition rather than a broken photo, and
   * why it is worth telling the user about.
   */
  | "undecodable-here";

export interface RenditionEntry {
  /**
   * The derived record's id, when there is one.
   *
   * Absent on an unavailable entry, which by definition names no record. Present
   * on an available one so a caller can go and get the bytes — a browser reads
   * `url` instead, but a surface holding the database directly needs the id.
   */
  readonly id?: string;
  /** Pixel long edge of this rung for *this* record, after clamping. */
  readonly longEdge: number;
  readonly available: boolean;
  /** Present only when `available` is false. */
  readonly state?: RenditionState;
  /** Present only when `available` is true. */
  readonly url?: string;
  readonly width?: number;
  readonly height?: number;
  readonly type?: string;
}

export interface RenditionChoice {
  /**
   * The rung the ladder says should answer this target for this record.
   *
   * Always a rung the record will *eventually* have, which is what makes
   * `available: false` reliably mean "not yet" and never "never".
   */
  readonly ideal: RenditionEntry;
  /**
   * The largest available rung strictly below the ideal. Absent when the ideal
   * is available, or when nothing below it has been derived.
   */
  readonly fallback?: RenditionEntry;
}

/** A derived child as the data server reports it. */
export interface DerivedChild {
  readonly id: string;
  readonly longEdge: number;
  readonly width: number;
  readonly height: number;
  readonly type: string;
  readonly url?: string;
}

export interface ResolveOptions {
  /** The original's long edge, from its stored dimensions. */
  readonly sourceLongEdge: number;
  readonly candidates: readonly DerivedChild[];
  /**
   * Why an unavailable rung is unavailable. Defaults to `pending`, which is
   * what it is on a node that could derive it and simply has not yet.
   */
  readonly unavailableState?: RenditionState;
}

/**
 * Resolve one target. See the file header for the rule; the cases below are
 * the ones worth having on record.
 *
 * - **4000 px source, target 540.** All five rungs apply. The ideal is 1280.
 *   If it has not been derived and 400 has, the answer is the ideal marked
 *   unavailable plus 400 as the fallback.
 * - **300 px source, target 2048.** Only the bottom two rungs apply and the
 *   second clamps to 300. Nothing reaches 2048, so the ideal is that 300 px
 *   rung and it is marked **available** once derived. The client is being told
 *   "this is as good as this photo gets", not "wait" — which is why an upgrade
 *   watcher must key on `available` and not on "smaller than I asked for".
 * - **4000 px source, target 540, 1280 missing but 2560 present.** The ideal is
 *   1280 and unavailable; the fallback is 400. The 2560 is ignored here and
 *   returned as the ideal when the viewer asks for 2048.
 */
export function resolveRendition(
  target: number,
  options: ResolveOptions,
): RenditionChoice {
  const applicable = applicableStillClasses(options.sourceLongEdge);
  const edges = applicable.map((spec) => effectiveLongEdge(spec, options.sourceLongEdge));

  // The smallest applicable rung that reaches the target; the top one when
  // none does. Compared against effective edges, never class maxima — a class
  // never upscales, so what it will actually emit is what resolution is about.
  let idealIndex = edges.findIndex((edge) => edge >= target);
  if (idealIndex === -1) idealIndex = applicable.length - 1;
  const idealEdge = edges[idealIndex]!;

  const byEdge = [...options.candidates].sort((a, b) => a.longEdge - b.longEdge);
  const idealChild = byEdge.find((c) => c.longEdge === idealEdge);
  if (idealChild) return { ideal: availableEntry(idealChild) };

  const ideal: RenditionEntry = {
    longEdge: idealEdge,
    available: false,
    state: options.unavailableState ?? "pending",
  };

  // Strictly below, and the largest such. Ties on long edge cannot happen
  // between two *applicable* rungs above the bottom, but a clamped ladder can
  // produce them, and taking the last of a sorted run is a defined choice.
  const below = byEdge.filter((c) => c.longEdge < idealEdge);
  const fallback = below[below.length - 1];
  return fallback ? { ideal, fallback: availableEntry(fallback) } : { ideal };
}

export function resolveRenditions(
  targets: readonly number[],
  options: ResolveOptions,
): Record<string, RenditionChoice> {
  const out: Record<string, RenditionChoice> = {};
  for (const target of targets) out[String(target)] = resolveRendition(target, options);
  return out;
}

/**
 * The answer for a record whose dimensions are not stored.
 *
 * An applicable set cannot be computed without them, so there is no ladder
 * rung to name yet. When children exist, resolving among them and calling the
 * selected one available remains the honest compatibility answer.
 *
 * When no children exist, returning no decision makes child-only writes
 * invisible to a parent-based incremental cursor: the client does not know it
 * is waiting, so it never performs the full re-list that can see the first
 * child. Return a provisional pending entry for each requested target. Its long
 * edge is the requested coverage, not a claimed ladder rung; once the metadata
 * write supplies source dimensions, normal resolution replaces it with the
 * exact clamped ideal.
 *
 * This case shrinks rather than grows — derivation now writes dimensions from
 * the decode it was doing anyway — so it is a compatibility path, not a
 * design.
 */
export function resolveWithoutDimensions(
  targets: readonly number[],
  candidates: readonly DerivedChild[],
  unavailableState: RenditionState = "pending",
): Record<string, RenditionChoice> {
  const byEdge = [...candidates].sort((a, b) => a.longEdge - b.longEdge);
  const out: Record<string, RenditionChoice> = {};
  if (byEdge.length === 0) {
    for (const target of targets) {
      out[String(target)] = {
        ideal: { longEdge: target, available: false, state: unavailableState },
      };
    }
    return out;
  }
  for (const target of targets) {
    const chosen = byEdge.find((c) => c.longEdge >= target) ?? byEdge[byEdge.length - 1]!;
    out[String(target)] = { ideal: availableEntry(chosen) };
  }
  return out;
}

function effectiveLongEdge(spec: StillClassSpec, sourceLongEdge: number): number {
  return renditionLongEdge(spec, sourceLongEdge);
}

function availableEntry(child: DerivedChild): RenditionEntry {
  return {
    id: child.id,
    longEdge: child.longEdge,
    available: true,
    width: child.width,
    height: child.height,
    type: child.type,
    ...(child.url ? { url: child.url } : {}),
  };
}
