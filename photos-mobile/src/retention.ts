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
 * `media-implementation-plan.md` §6.2's default table, verbatim — 19 GB across
 * twelve rows, sized as **working sets rather than libraries**. They are not
 * tuned here, because inventing a second set of numbers beside a documented one
 * is how the two come to disagree.
 *
 * The `keep` rules are this file's own choice, and they follow one rule: the
 * smaller the rendition, the more of the library it should cover. Thumbnails are
 * `all`, because a grid that cannot draw is a phone that looks broken offline
 * and 50,000 tiles fit in a gigabyte. The largest rungs are `on-demand-only`,
 * because they exist for zooming into one photo and fetching them speculatively
 * would spend the whole budget on things nobody looked at. Originals sit in the
 * middle at `recent-only`.
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

/**
 * How far back "recent" reaches, in days.
 *
 * One month rather than a year. The recency window is the axis a phone's budget
 * is most sensitive to — it multiplies straight into bytes — and the working-set
 * argument the budgets are built on says the same thing: what a person opens on
 * a handset is overwhelmingly what they took this month, and everything older is
 * one tap away through {@link MobileNode.fetchBlob}.
 */
export const PHONE_RECENCY_WINDOW_DAYS = 30;

/**
 * Also keep anything opened within this many days, however old it is.
 *
 * A library you actually browse has a shape that is not its calendar. Wider than
 * the recency window on purpose: opening a photograph from four years ago is a
 * much stronger signal about what this device should keep than the date on it,
 * and the cost of honouring that signal is bounded by the same budget.
 */
export const PHONE_OPENED_WITHIN_DAYS = 90;

const recent = (budgetBytes: number) =>
  ({
    keep: "recent-only",
    recencyWindowDays: PHONE_RECENCY_WINDOW_DAYS,
    openedWithinDays: PHONE_OPENED_WITHIN_DAYS,
    budgetBytes,
  }) as const;

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
      // order things happened to arrive.
      "original:image": recent(2 * GB),
      "original:video": recent(3 * GB),
    },
    // A category this app has no ladder for — an audio file, a PDF someone put
    // in Drive. On-demand rather than never: the record is browsable and one tap
    // brings the bytes, which is the honest behaviour for something this app was
    // not built to display anyway.
    fallback: { keep: "on-demand-only", budgetBytes: 512 * MB },
  },
  apps: {
    [PHOTOS_APP_ID]: {
      rows: {
        // Everything the grid needs to draw itself with no network at all.
        "image-xsmall": { keep: "all", budgetBytes: 256 * MB },
        "image-thumb": { keep: "all", budgetBytes: 1 * GB },
        // The routine working rendition: fullscreen stage 1, share/export,
        // on-device AI. Worth keeping the whole library's worth if it fits.
        "image-medium": { keep: "all", budgetBytes: 4 * GB },
        // Fullscreen at retina. Recent only — this is where the budget starts to
        // bite and where the recency window earns its place.
        "image-screen": recent(2 * GB),
        // 4K TV, zoom, print preview. Fetched when someone actually zooms.
        "image-large": { keep: "on-demand-only", budgetBytes: 1 * GB },
        "video-poster-thumb": { keep: "all", budgetBytes: 200 * MB },
        "video-poster-720p": { keep: "all", budgetBytes: 300 * MB },
        "video-skim": { keep: "all", budgetBytes: 512 * MB },
        "video-720p": recent(4 * GB),
        "video-1080p": { keep: "on-demand-only", budgetBytes: 1 * GB },
      },
      // A rung this build does not know about — the ladder respecified on
      // another node, or a class added since. Deliberately not `never`: an
      // unrecognised rendition is still something an app derived on purpose, and
      // declining it outright would make a respec invisible rather than merely
      // conservative.
      fallback: { keep: "on-demand-only", budgetBytes: 256 * MB },
      // What makes rung invention safe. Without it an app naming a thousand
      // rungs gets a thousand fallback budgets; with it, it still cannot exceed
      // one number. 14 GB of renditions plus 5 GB of originals is the plan's
      // 19 GB total.
      totalBudgetBytes: 14 * GB,
    },
  },
  // Some other app's derivatives, on a handset that is only running Photos.
  // Small and on-demand: they are real data and this device is not the place
  // for them.
  appFallback: {
    rows: {},
    fallback: { keep: "on-demand-only", budgetBytes: 256 * MB },
    totalBudgetBytes: 512 * MB,
  },
};

/** Every byte this policy permits, for the Storage section's headline figure. */
export function totalBudgetBytes(policy: NodeRetentionPolicy = PHONE_RETENTION): number {
  const platform = Object.values(policy.platform.rows).reduce(
    (sum, row) => sum + row.budgetBytes,
    0,
  );
  const apps = Object.values(policy.apps).reduce(
    (sum, app) => sum + app.totalBudgetBytes,
    0,
  );
  return platform + apps;
}
