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

import type { NodeRetentionPolicy } from "@starkeep/sync-engine";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/** Pulled during a sync round, with a share of the namespace budget. */
const prefetched = (share: number) => ({ prefetch: true, share }) as const;
/** Held only once something asks for it, then cached within this share. */
const onDemand = (share: number) => ({ prefetch: false, share }) as const;

/**
 * The rungs of Photos' own ladder, from `media-implementation-plan.md` §3.
 *
 * Named here rather than imported because they are the *app's* vocabulary and
 * this is the app — the platform deliberately never learns what `image-medium`
 * is, which is what lets the ladder be respecified without a change anywhere in
 * `@starkeep/sync-engine`.
 */
export const PHOTOS_APP_ID = "photos";

/** Which label key names a rung of that ladder. */
export const PHOTOS_SIZE_CLASS_KEY = "rendition";

export const PHONE_RETENTION: NodeRetentionPolicy = {
  platform: {
    rows: {
      // Split photo/video because one 4K clip is worth hundreds of stills, and
      // under a pooled budget one silently starves the other depending on the
      // order things happened to arrive. 2 GB and 3 GB of the 5.
      //
      // **On demand, not prefetched, and the shares stay non-zero.** An
      // original is the largest thing in the ladder and the least often looked
      // at: `image-medium` serves fullscreen, share, export and on-device AI,
      // so the only reader of an original on a handset is an explicit request.
      // Prefetching them was the single largest source of the waste this app's
      // acquisition order exists to bound — a twenty-year library transferred
      // in full to retain the newest 2 GB of it, rewriting the phone's flash in
      // budget-sized increments on the way. `prefetch: false` still holds the
      // bytes once someone taps, and caches them within this share; `share: 0`
      // would refuse an original even then, which is a different and wrong
      // policy.
      //
      // A **Photos** statement rather than a platform one. Drive has no ladder,
      // every record there is an original, and a node declining to prefetch
      // originals would hold nothing at all. This file is the phone's own
      // policy, so nothing generalises from it.
      "original:image": onDemand(40),
      "original:video": onDemand(60),
    },
    // A category this app has no ladder for — an audio file, a PDF someone put
    // in Drive — pooled with every other unrecognised rung of the platform
    // namespace. On demand rather than nothing: the record is browsable and one
    // tap brings the bytes, which is the honest behaviour for something this
    // app was not built to display anyway. Its share is deliberately small.
    fallback: onDemand(10),
    budgetBytes: 5 * GB + 512 * MB,
  },
  apps: {
    [PHOTOS_APP_ID]: {
      rows: {
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
      },
      // A rung this build does not know about — the ladder respecified on
      // another node, or a class added since. Deliberately not zero: an
      // unrecognised rendition is still something an app derived on purpose,
      // and refusing it outright would make a respec invisible rather than
      // merely conservative. One share between all of them, which is what makes
      // rung invention cheap instead of free.
      fallback: onDemand(2),
      budgetBytes: 14 * GB,
    },
  },
  // Some other app's derivatives, on a handset that is only running Photos.
  // Small and on demand: they are real data and this device is not the place
  // for them.
  appFallback: {
    rows: {},
    fallback: onDemand(1),
    budgetBytes: 512 * MB,
  },
};

/**
 * Every byte this policy permits, for the Storage section's headline figure.
 *
 * One line now. It used to sum the platform rows and then add each app's
 * separate total, which quietly asserted that those two levels were
 * commensurable — the assumption that let the rows and the total disagree in
 * the first place.
 */
export function totalBudgetBytes(policy: NodeRetentionPolicy = PHONE_RETENTION): number {
  return (
    policy.platform.budgetBytes +
    Object.values(policy.apps).reduce((sum, app) => sum + app.budgetBytes, 0)
  );
}
