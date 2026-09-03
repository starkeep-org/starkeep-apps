/**
 * The mark a Motion Photo tile carries.
 *
 * ## Why a mark at all
 *
 * A Motion Photo is indistinguishable from a still until it is opened. The
 * motion is inside the same JPEG, the tile draws the same frame, and the only
 * way to find out was to tap every photograph in the library. That makes a
 * feature the app does have unfindable, which is close to not having it.
 *
 * ## Why the same corner and the same style as {@link VideoBadge}
 *
 * The two answer the same question — *is there something to play here* — and a
 * tile can never carry both, because a Motion Photo is an image record and the
 * video badge is only drawn for videos. Marking them in one corner in one style
 * makes them one vocabulary rather than two competing ones.
 *
 * The glyph is the one the viewer's own motion control already uses, so the tile
 * and the control that plays it say the same thing. The word is lowercase for
 * the same reason `formatDuration` renders an unmeasured clip as "video": a
 * corner mark is a label, not an announcement.
 */

import { Text } from "react-native";
import { styles } from "./theme";

export function MotionBadge() {
  return <Text style={styles.tileBadge}>{"◉ motion"}</Text>;
}
