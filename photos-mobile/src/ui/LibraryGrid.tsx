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
 *
 * ## Three things the viewer can be showing
 *
 * A still, a video, or a photograph that moves — and they are three because the
 * records are two and the second of them has an inside.
 *
 * A **video record** gets a player with the platform's own controls, opened on
 * its first frame and never autoplaying. A **still** gets an `<Image>` and a tap
 * anywhere dismisses it. A **Motion Photo** is a still until somebody asks: it is
 * one image record whose bytes happen to carry a trailing MP4, and the control
 * that plays it materialises a scratch file for that viewing and deletes it
 * afterwards. See `media/motion-photo-playback.ts` for why nothing is kept.
 */

import { memo, useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
// **`expo-image`, not React Native's `<Image>`, and the reason is a decode.**
// RN's image pipeline is Fresco, whose AVIF path defers to the platform
// decoder — and a Pixel 5 on API 34 fails every AVIF still the ladder produces,
// at both AV1 profiles, without instantiating an AV1 codec at all. Every rung
// of the ladder is AVIF, so the entire rendition ladder painted nothing on
// Android; it went unnoticed only because no image rendition had ever been
// fetched and every tile fell back to the camera-roll original. `expo-image`
// renders through Glide, which carries its own AVIF decoder.
// See `photos-mobile-status-2026-08-31.md`.
import { Image } from "expo-image";
import type { LibraryItem } from "../library";
import type { OpenMotionPhoto } from "../media/motion-photo-playback";
import { CONTENT_PADDING, GRID_COLUMNS, GRID_GAP, styles, TILE_WIDTH_FRACTION } from "./theme";
import { MotionBadge } from "./MotionBadge";
import { VideoBadge } from "./VideoBadge";
import { LibraryViewer } from "./LibraryViewer";
import { isVideo } from "./format";

/** What the viewer needs from the screen that hosts it. */
export interface ViewerHost {
  /**
   * Fetch a record whose bytes are not on this device.
   *
   * Required rather than optional, because a placeholder tile with no way to
   * act on it is the state the residency design says must not exist: eliding
   * advances the watermark, so nothing in a sync round will ever offer those
   * bytes again and this is the only route back.
   */
  readonly onFetch: (item: LibraryItem) => Promise<boolean>;
  /**
   * Keep this record on this device regardless of budget, or stop.
   *
   * Returns the state afterwards so the control can reflect it without the
   * whole library being reloaded for one toggle.
   */
  readonly onSetPinned: (recordId: string, pinned: boolean) => boolean;
  readonly isPinned: (recordId: string) => boolean;
  /**
   * Someone looked at this record.
   *
   * Reported from here rather than inferred, because opening a photo is the
   * event — not fetching it, which is what used to be recorded and which only
   * ever happened for records this device had already declined.
   */
  readonly onOpened: (recordId: string) => void;
  /**
   * The clip inside a Motion Photo, materialised for one viewing.
   *
   * Answers null for the ordinary photograph, which is most of them — the viewer
   * simply shows no motion control. The handle it does answer must be released
   * when the viewer closes; the scratch file lasts exactly one viewing by design.
   */
  readonly onOpenMotion: (item: LibraryItem) => Promise<OpenMotionPhoto | null>;
}

/**
 * The rows a page of records lays out as.
 *
 * Rows rather than tiles, because the list that draws them is virtualized and a
 * virtualized list windows whole items: one tile per item would let a list
 * unmount two thirds of a visible row. Chunking here also puts the column count
 * in one place — `theme.ts` — instead of implying it from a width fraction.
 */
export function libraryRows(items: readonly LibraryItem[]): LibraryItem[][] {
  const rows: LibraryItem[][] = [];
  for (let i = 0; i < items.length; i += GRID_COLUMNS) {
    rows.push(items.slice(i, i + GRID_COLUMNS));
  }
  return rows;
}

/**
 * How tall one row is, in layout points.
 *
 * Computed rather than measured, and supplied to the list as `getItemLayout`, so
 * scrolling and position restoration need no measurement pass at all. The
 * arithmetic is the grid's whole geometry: a tile is square and takes
 * {@link TILE_WIDTH_FRACTION} of the padded width, and the rows are separated by
 * the same gap the tiles are.
 */
export function libraryRowHeight(windowWidth: number): number {
  return (windowWidth - CONTENT_PADDING * 2) * TILE_WIDTH_FRACTION + GRID_GAP;
}

/** A stable key for a row: its first record, which never moves within the row. */
export function libraryRowKey(row: readonly LibraryItem[]): string {
  return row[0]?.record.id ?? "empty";
}

/**
 * One row of the library grid.
 *
 * `memo` because a virtualized list re-renders its container far more often
 * than its contents change — every scroll event, every appended page — and a row
 * that re-renders hands `expo-image` a new source object, which is what makes a
 * tile flash back to nothing and decode again.
 */
export const LibraryRow = memo(function LibraryRow({
  row,
  onOpen,
}: {
  readonly row: readonly LibraryItem[];
  readonly onOpen: (item: LibraryItem) => void;
}) {
  return (
    <View style={styles.gridRow}>
      {row.map((item) => (
        <Pressable key={item.record.id} onPress={() => onOpen(item)} style={styles.tile}>
          {item.uri ? (
            <Image
              source={{ uri: item.uri }}
              style={styles.tileImage}
              contentFit="cover"
              // **The recycling key, and it is not optional in a virtualized
              // list.** `expo-image` reuses the native view when a row scrolls
              // out and another takes its slot; without a key tying the view to
              // a record, the recycled view keeps painting the previous
              // photograph until the new one decodes. The symptom is a grid that
              // shows the wrong pictures for a frame or two during a fast
              // scroll, which reads as data corruption rather than as a decode.
              recyclingKey={item.record.id}
              // Disk, not memory. A tile is cheap to decode again from a file
              // that is already on this device, and there are thousands of them
              // — a memory cache over the whole library is unbounded growth for
              // a saving nobody notices. The viewer keeps its own memory cache,
              // because it holds one picture at a time and re-decoding a 40
              // megapixel original is exactly the cost worth paying once.
              cachePolicy="disk"
              // A tile loses to a photograph somebody is waiting to look at.
              priority="low"
            />
          ) : (
            // A record with no bytes on this device to draw from. `◇` is a
            // blob elided or still owed, which is what the fetch control in
            // the viewer exists for. A video no longer lands here whenever
            // its bytes are present: `expo-image` paints its first frame, so
            // it draws above like any still, and the badge below marks it as
            // a clip in the same corner the device grid uses.
            <View style={[styles.tileImage, styles.tilePlaceholder]}>
              {item.bytesHere ? null : <Text style={styles.tilePlaceholderMark}>◇</Text>}
            </View>
          )}
          {/* On the tile whatever is underneath it, because the question it
              answers — is this a clip, and how long — does not change when a
              poster rendition finally arrives.

              The two marks are exclusive by construction: a Motion Photo is an
              image record, so `isVideo` is false for every tile that could
              carry the motion mark. */}
          {isVideo(item) ? (
            <VideoBadge durationMs={item.durationMs} />
          ) : item.hasMotion ? (
            <MotionBadge />
          ) : null}
        </Pressable>
      ))}
    </View>
  );
});

/**
 * The viewer's state, and the element that draws it.
 *
 * A hook rather than a component wrapping the grid, because the grid is no
 * longer a component that contains its tiles — the rows are items of a list the
 * screen owns. So the screen owns the viewer too, calls {@link open} from a row,
 * and renders {@link element} once, outside the list. Rendering it inside would
 * put a full-screen modal inside a recycled row.
 */
export function useLibraryViewer({
  onFetch,
  onSetPinned,
  isPinned,
  onOpened,
  onOpenMotion,
}: ViewerHost): { open: (item: LibraryItem) => void; element: React.ReactElement } {
  const [item, setItem] = useState<LibraryItem | null>(null);
  /** The key currently being fetched, so the control can say so. */
  const [fetching, setFetching] = useState<string | null>(null);
  /** Pinned state of the open record, so the toggle is not a round trip. */
  const [pinned, setPinned] = useState(false);

  const open = useCallback(
    (opened: LibraryItem) => {
      onOpened(opened.record.id);
      setPinned(isPinned(opened.record.id));
      setItem(opened);
    },
    [onOpened, isPinned],
  );

  const fetchNow = useCallback(
    async (target: LibraryItem): Promise<boolean> => {
      setFetching(target.record.id);
      try {
        return await onFetch(target);
      } finally {
        setFetching(null);
      }
    },
    [onFetch],
  );

  const element = (
    <LibraryViewer
      item={item}
      busy={item !== null && fetching === item.record.id}
      pinned={pinned}
      onTogglePin={(target) => setPinned(onSetPinned(target.record.id, !pinned))}
      onFetch={fetchNow}
      onOpenMotion={onOpenMotion}
      onClose={() => setItem(null)}
    />
  );

  return { open, element };
}
