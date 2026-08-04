/**
 * The node's library, and a photo you can open.
 *
 * ## What is different from `MediaGrid`
 *
 * `MediaGrid` shows the *device's* camera roll, read straight from the media
 * store. This shows the *node's* records. On a phone that has imported its
 * camera roll the pictures are the same; the difference is that these are
 * things Starkeep holds — hashed, addressed, and ready to sync the day there is
 * anywhere to sync to.
 *
 * Both exist on purpose for now. The camera-roll grid is what the app can show
 * before anything is imported, and it is the honest answer to "what is on this
 * phone"; the library is the answer to "what does this node have". They stop
 * agreeing as soon as either syncing or deleting happens, and when they do,
 * saying so plainly beats silently picking one.
 *
 * ## The tiles are tappable, which they were not before
 *
 * A grid of photographs that does nothing when touched reads as broken — every
 * other photo app on the device opens the picture. So a tile opens a viewer.
 * The viewer renders the original, which is fine at one-photo-at-a-time and is
 * exactly what `import-loop-design.md` §3.2 says renditions are not needed for
 * yet.
 */

import { useState } from "react";
import { Image, Modal, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { LibraryItem } from "../library";
import { styles } from "./theme";

interface Props {
  readonly items: readonly LibraryItem[];
  readonly loading: boolean;
  /**
   * Fetch a record whose bytes are not on this device.
   *
   * Required rather than optional, because a placeholder tile with no way to
   * act on it is the state the residency design says must not exist: eliding
   * advances the watermark, so nothing in a sync round will ever offer those
   * bytes again and this is the only route back.
   */
  readonly onFetch: (item: LibraryItem) => Promise<boolean>;
}

export function LibraryGrid({ items, loading, onFetch }: Props) {
  const [open, setOpen] = useState<LibraryItem | null>(null);
  /** The key currently being fetched, so the tile can say so. */
  const [fetching, setFetching] = useState<string | null>(null);

  async function fetchNow(item: LibraryItem): Promise<boolean> {
    setFetching(item.record.id);
    try {
      return await onFetch(item);
    } finally {
      setFetching(null);
    }
  }

  if (items.length === 0) {
    return (
      <Text style={styles.muted}>
        {loading
          ? "Reading this node's library…"
          : "Nothing has been added to this node yet. The photos on this device are still just on this device."}
      </Text>
    );
  }

  return (
    <View style={{ gap: 8 }}>
      <View style={styles.grid}>
        {items.map((item) => (
          <Pressable key={item.record.id} onPress={() => setOpen(item)} style={styles.tile}>
            {item.uri ? (
              <Image source={{ uri: item.uri }} style={styles.tileImage} resizeMode="cover" />
            ) : (
              // A record whose bytes are not on this device. Expected, not an
              // error — it is what an elided or not-yet-fetched blob looks like.
              <View style={[styles.tileImage, styles.tilePlaceholder]}>
                <Text style={styles.tilePlaceholderMark}>◇</Text>
              </View>
            )}
          </Pressable>
        ))}
      </View>
      <Text style={styles.muted}>
        {items.length} {items.length === 1 ? "record" : "records"} in this node&rsquo;s library.
        Tap one to open it.
      </Text>

      <Viewer
        item={open}
        busy={open !== null && fetching === open.record.id}
        onFetch={fetchNow}
        onClose={() => setOpen(null)}
      />
    </View>
  );
}

/**
 * One photo, full screen.
 *
 * A `Modal` rather than a navigator: there is one thing to push and one way
 * back, and the day there is a stack worth managing is the day to add one —
 * the same argument `App.tsx` makes about the shell.
 */
function Viewer({
  item,
  busy,
  onFetch,
  onClose,
}: {
  item: LibraryItem | null;
  busy: boolean;
  onFetch: (item: LibraryItem) => Promise<boolean>;
  onClose: () => void;
}) {
  if (!item) return null;
  const { record, uri } = item;

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} transparent={false}>
      <SafeAreaView style={styles.viewerSafe}>
        <Pressable style={styles.viewerImageArea} onPress={onClose}>
          {uri ? (
            <Image source={{ uri }} style={styles.viewerImage} resizeMode="contain" />
          ) : (
            <Text style={styles.muted}>
              This record&rsquo;s bytes are not on this device.
            </Text>
          )}
        </Pressable>

        <View style={styles.viewerFooter}>
          <Text style={styles.body}>{record.originalFilename ?? "unnamed"}</Text>
          <Text style={styles.muted}>
            {record.type} · {formatBytes(record.sizeBytes)}
          </Text>
          {/* The content hash, abbreviated. On screen because this is the one
              place the difference between "a photo" and "a record" is visible,
              and because it is what a second device would match it by. */}
          <Text style={styles.mono}>{record.contentHash?.slice(0, 16) ?? "no hash"}…</Text>
          {/* The reversal half of eliding, and the only one there is. A record
              this node declined has already had its watermark advanced past it,
              so no sync round will offer the bytes again — without this button
              a budget on a phone would be indistinguishable from losing the
              photo. */}
          {uri ? null : (
            <Pressable
              onPress={() => void onFetch(item)}
              disabled={busy}
              style={{ paddingVertical: 8 }}
            >
              <Text style={styles.linkLabel}>
                {busy ? "Fetching…" : "Fetch these bytes"}
              </Text>
            </Pressable>
          )}
          <Pressable onPress={onClose} style={{ paddingVertical: 8 }}>
            <Text style={styles.linkLabel}>Close</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
