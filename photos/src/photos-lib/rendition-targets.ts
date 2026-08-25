/**
 * How many sizes one list request may ask for.
 *
 * Each target is a separate resolution over the same candidate set, so an
 * unbounded list is a cheap way to inflate a response. Two is what progressive
 * presentation actually needs — the tile now, and the viewport size ready for
 * the moment someone opens one — and the headroom above that is for a surface
 * that wants a third.
 *
 * Kept alongside the ladder rather than imported from the platform: the
 * platform's own cap applies to *its* resolution, and this route does not use
 * that path at all.
 */
export const MAX_VARIANT_TARGETS = 4;
