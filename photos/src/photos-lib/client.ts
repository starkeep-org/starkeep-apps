/**
 * The half of `photos-lib` a browser can load.
 *
 * ## Why this file exists
 *
 * `photos-lib/index.ts` is one barrel over everything, and most of what it
 * re-exports is Node-only: `derive-ladder` imports `sharp`, `video-tools`
 * shells out to ffmpeg, `run-import` walks the filesystem. A React component
 * that wanted the `AppImage` *type* pulled the whole barrel, and the bundler
 * followed it all the way to `sharp` → `detect-libc` → `child_process`, which
 * has no meaning in a browser. The build failed with a message about
 * `child_process` in a file nobody in this app has ever opened.
 *
 * The import trace was the only clue, and it read backwards from the symptom:
 * `page.tsx → app.tsx → photoRecordToAppImage → photos-lib → derive-ladder →
 * sharp → detect-libc → child_process`. Every step is a barrel re-export
 * except the last two.
 *
 * ## What belongs here
 *
 * Only code that is genuinely platform-free — no `node:` imports, no native
 * modules, transitively. Today that is three things, and they are exactly what
 * the UI reaches for:
 *
 * - the `AppImage` shape the components render
 * - `derivedKindOf`, which reads a label
 * - `variantSrc` and friends, which are arithmetic over what a record already
 *   carries
 *
 * ## The rule for adding to it
 *
 * Anything exported here must be importable from a browser bundle with no
 * polyfills. If a new export needs `sharp`, ffmpeg, `node:fs` or a decoder, it
 * belongs in `index.ts` and the caller belongs on the server. The cheap check
 * is that the client build stays green; the honest check is reading what the
 * new module imports.
 *
 * This is the near half of the `photos-lib` split the Android plan's §6 risk
 * predicted ("expect to split it before item 15a rather than during") — and the
 * same split `photos-mobile` needs, since React Native cannot load `sharp`
 * either. Doing it as two entry points over one directory keeps a single copy
 * of the logic, which is the property that matters: a second implementation of
 * the ladder for mobile is how two nodes come to disagree.
 */

export type { AppImage, AppImageExif, DerivedKind } from "./types/app-image";

export {
  PHOTOS_APP_ID,
  PHOTOS_LABEL_KEYS,
  derivedKindOf,
  isThumbnail,
  renditionClassOf,
  type LabelledRecord,
} from "./labels";

export {
  variantSrc,
  stillDisplay,
  displayForRenditionChoice,
  posterSrc,
  playbackSrc,
  isVideoRecord,
  type DisplaySource,
} from "./variant-src";
