/**
 * Justified row layout — re-exported from the package every Photos surface
 * shares.
 *
 * Moved out to `@starkeep/photos-ladder` when the phone's grid stopped being a
 * fixed three-column square crop and became justified rows too. Two
 * implementations of a layout rule that disagree is a grid that looks different
 * on one device class, which is the same argument the ladder itself was
 * extracted on, and it is worse here: the layout decides the *box*, and the box
 * is what `measuredPhysicalLongEdge` sizes the request from. A second layout
 * would therefore disagree about which rung to fetch as well as about where to
 * put it.
 *
 * The package's rule holds — it is arithmetic over aspect ratios and a
 * container width, with no DOM and no React — which is what lets a React Native
 * bundle consume the same rows a browser lays out.
 *
 * This file stays as the name the grid already imports, so the extraction is
 * invisible from here.
 */

export {
  justifiedRows,
  type JustifiedLayoutOptions,
  type JustifiedPlacement,
  type JustifiedRow,
} from "@starkeep/photos-ladder";
