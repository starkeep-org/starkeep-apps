/**
 * The budget this phone actually runs under.
 *
 * ## Why there is a default at all
 *
 * `createMobileNode` treats an absent policy as "keep everything", and that is
 * the right *default for the type* — a node that has not been told its budget
 * must not silently start declining data, because over-fetching costs disk and
 * under-fetching costs a photo that is quietly nowhere. But `bringUpNode` never
 * passed one, so on every real device `residency` was null: no budget, no class
 * resolution, no eviction, no pins. The whole residency half of the system was
 * present, tested, and unreachable, and this file is the smallest thing that
 * changes that.
 *
 * A handset is also the one node where the question is not academic. A laptop
 * with no policy wants every blob and is usually right; a phone with 8 GB free
 * against a 60,000-item library is the only honest consumer of `Elided`.
 *
 * ## Where these numbers come from
 *
 * `media-implementation-plan.md` §6.2's default table, restated as one budget
 * per namespace and shares within it — 19 GB total, 5 GB of originals and 14 GB
 * of renditions, sized as **working sets rather than libraries**.
 *
 * The restatement is not cosmetic. The old table gave every row an absolute
 * byte count *and* declared a separate namespace total, and nothing made the
 * two agree: the photos rows summed to roughly 14.24 GB against a stated total
 * of 14 GB, and the comment beside it confidently described the arithmetic it
 * had drifted from. Shares cannot drift, because there is only one byte count
 * to drift from.
 *
 * ## What the shares mean
 *
 * They are percentages of the namespace's budget and nothing depends on them
 * summing to a hundred — only ratios matter. They follow one rule: the smaller
 * the rendition, the more of the library it should cover. Thumbnails get enough
 * to hold the whole grid, because a grid that cannot draw is a phone that looks
 * broken offline. That rule is checked against measured bytes rather than
 * asserted; see "Why these shares and not the old ones" below. The largest
 * rungs — `image-large`, `video-1080p`, and the
 * originals themselves — are not prefetched, because they exist for zooming
 * into one photograph and pulling them speculatively would spend the budget on
 * bytes nobody looked at — the one judgement here that a cache's eviction order
 * genuinely cannot make for itself, since by the time it could, the download has
 * happened.
 *
 * ## Why these shares and not the old ones
 *
 * The first set of shares was written against a ladder whose bottom two rungs
 * were 128 px and 400 px. `image-xsmall` moved to 320 and `image-thumb` to 640,
 * which multiplies the pixel count by 6.25 and 2.56, and the shares did not
 * move with them. A rung that is meant to cover the library and covers half of
 * it is the failure this file exists to prevent, and it is invisible until a
 * phone is offline in front of a grid it cannot draw.
 *
 * So the two bottom rungs are now sized from **measured** renditions rather
 * than from reasoning about them. Against the local library, AVIF at quality
 * 50 averages 8.8 KB at `image-xsmall` and 31.0 KB at `image-thumb`, which puts
 * a 60,000-item library at 0.49 GB and 1.73 GB. The shares below give them
 * 0.54 GB and 1.75 GB — the whole library with a little headroom, which is what
 * the rule above actually asks for.
 *
 * The bytes come from `image-medium`, whose coverage falls from 50% of the
 * library to 37%. That is the right line to charge, and its own note says why:
 * it wants the whole library *if it fits*, where the two rungs below it are
 * what make the app work at all when nothing fits. A missing `image-medium`
 * degrades to a thumbnail; a missing thumbnail degrades to a grey square.
 *
 * `video-poster-thumb` follows `image-thumb` from 1 to 2, because the ladder
 * pins the poster to the still rung and the same 2.56× applies to it.
 *
 * **The sample is small — seven originals — so treat these as a correction to
 * numbers that were provably wrong rather than as the final word.** The figure
 * to re-measure is bytes per rung across a real library, and the arithmetic
 * above is the whole of what depends on it.
 *
 * ## What this budget does *not* govern
 *
 * Photographs taken on this device. Import aliases them to the MediaStore assets
 * that already hold their bytes rather than copying (`import-loop-design.md`
 * §2), so this node does not hold them, does not count them, and — the part that
 * matters — cannot evict them: `DeviceMediaObjectStorage.delete()` drops an
 * alias row and never an asset. `original:image` here is therefore about
 * originals *fetched from the cloud*, which is to say photographs taken on some
 * other device.
 */

export interface RungRetention { readonly prefetch: boolean; readonly share: number }
const prefetched = (share: number) => ({ prefetch: true, share });
const onDemand = (share: number) => ({ prefetch: false, share });

/**
 * How Photos divides its own ceiling between the rungs of its ladder.
 *
 * **Photos' table, not the platform's.** The platform's retention policy gives
 * this app one advisory ceiling per node and stops there: it cannot tell a
 * thumbnail from a 4K master, and a budget that tried to would be the platform
 * holding an opinion about a ladder it deliberately never learns. So the shares
 * and the prefetch flags live here, where the ladder does.
 *
 * Between this change and the acquisition pass that reads it, nothing
 * prefetches an app blob on a handset — a sync round applies Photos' rows and
 * leaves its bytes alone, and a tap still lands what it asks for. The gap is
 * deliberate and bounded, and these numbers are the record of what closes it:
 * they were measured against a real library and the comments beside them are
 * the only written account of where each came from.
 */
export const PHOTOS_RUNG_SHARES: Readonly<Record<string, RungRetention>> = {
  // Everything the grid needs to draw itself with no network at all.
  // Sized to hold the whole library at the rungs' measured byte cost —
  // 0.54 GB and 1.75 GB against 0.49 GB and 1.73 GB needed. See "Why
  // these shares and not the old ones".
  "image-xsmall": prefetched(4),
  "image-thumb": prefetched(13),
  // The routine working rendition: fullscreen stage 1, share/export,
  // on-device AI. Worth keeping the whole library's worth if it fits —
  // and at 136 KB a record it does not fit, so this is the line that pays
  // for the two above. 2.83 GB, or 37% of a 60,000-item library.
  "image-medium": prefetched(21),
  // Fullscreen at retina. The budget starts to bite here, which under the
  // old table was spelled `recent-only` with a 30-day window — a rule
  // that never once bound, because a rendition carries no capture date.
  // A share does bind, and the eviction order decides which screens
  // survive it.
  "image-screen": prefetched(14),
  // 4K TV, zoom, print preview. Fetched when someone actually zooms.
  "image-large": onDemand(7),
  // Pinned to `image-thumb` by the ladder, so it moved when that rung did.
  "video-poster-thumb": prefetched(2),
  "video-poster-720p": prefetched(2),
  "video-skim": prefetched(4),
  "video-720p": prefetched(28),
  "video-1080p": onDemand(7),
};

/**
 * The share given to a rung this build does not know about — the ladder
 * respecified on another node, or a class added since.
 *
 * Deliberately not zero: an unrecognised rendition is still something an app
 * derived on purpose, and refusing it outright would make a respec invisible
 * rather than merely conservative. One share between all of them, which is what
 * makes rung invention cheap instead of free.
 */
export const PHOTOS_FALLBACK_SHARE: RungRetention = onDemand(2);


/** Desktop proportions are provisional; phone measurements do not establish desktop needs. */
export const DESKTOP_RUNG_SHARES: Readonly<Record<string, RungRetention>> = Object.fromEntries(
  Object.entries(PHOTOS_RUNG_SHARES).map(([name, policy]) => [name, { ...policy, prefetch: false }]),
);
export const DESKTOP_FALLBACK_SHARE: RungRetention = { ...PHOTOS_FALLBACK_SHARE };
