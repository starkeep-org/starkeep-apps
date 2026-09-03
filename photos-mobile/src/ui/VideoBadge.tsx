/**
 * The mark a video tile carries, in both grids.
 *
 * ## Why one component rather than two badges
 *
 * `MediaGrid` and `LibraryGrid` draw the same files — on a phone that has
 * imported its camera roll they are the same pictures — and they used to mark
 * them differently: the device grid put a bare duration in the bottom-right
 * corner, and the library grid painted a `▶` in the middle of an empty
 * placeholder and said nothing about length. Two grids that mark the same file
 * two ways read as two apps, and neither mark answered both of the questions a
 * person actually has, which are *is this a video* and *how long is it*.
 *
 * So one component answers both, in one corner, for both grids.
 *
 * ## Why the glyph and the duration are one pill
 *
 * The glyph is what makes a still frame legible as a clip; the duration is what
 * makes it worth tapping. Splitting them across two corners would make the
 * shorter of the two — the glyph — the one that reads as decoration.
 *
 * A duration nothing measured renders as the word "video", which is
 * `formatDuration`'s answer and the true one: a tile claiming `0:00` describes a
 * broken file, and the file is fine.
 */

import { Text } from "react-native";
import { formatDuration } from "../media/device-library";
import { styles } from "./theme";

export function VideoBadge({ durationMs }: { readonly durationMs: number | null }) {
  return <Text style={styles.tileBadge}>{`▶ ${formatDuration(durationMs)}`}</Text>;
}
