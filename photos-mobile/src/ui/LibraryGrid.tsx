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
 * ## Justified rows, not a square grid
 *
 * The grid used to be three square tiles across, each showing a centre crop.
 * That is right for `MediaGrid`, whose job is a contact sheet of the camera
 * roll, and wrong here: a square crop of a photograph is not the photograph, and
 * the library is where somebody looks at their pictures.
 *
 * It was also sizing the renditions wrong. A square tile is the wrong box to
 * measure a request against — a portrait photograph inside one is drawn shorter
 * and narrower than the tile — so the pixel count was computed for pixels the
 * picture does not occupy. Justified rows give each photograph a box of its own
 * shape, which is what makes the layout and the request agree.
 *
 * The layout is the web app's, from `@starkeep/photos-ladder`, reached through
 * `photos/render-target.ts` because a component may not import the ladder
 * directly. See `theme.ts`'s `LIBRARY_ROW_HEIGHT`.
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

import { memo, useCallback, useRef, useState } from "react";
import { InteractionManager, Pressable, Text, View } from "react-native";
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
import { layOutRows, type JustifiedRow } from "../photos/render-target";
import { CONTENT_PADDING, GRID_GAP, LIBRARY_ROW_HEIGHT, styles } from "./theme";
import { MotionBadge } from "./MotionBadge";
import { VideoBadge } from "./VideoBadge";
import { LibraryViewer, type ViewerStep } from "./LibraryViewer";
import { isVideo } from "./format";
import { perf } from "./perf";

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
   * Fetch the rung a surface wants, when its bytes are not on this device.
   *
   * Fired by the viewer on open, unconditionally: a full screen wants a bigger
   * rung than any tile, so opening a photograph is exactly when the phone
   * discovers it does not have one. Nothing on screen waits for it — the viewer
   * paints whatever already resolved and improves when the bytes land.
   */
  readonly onFetchRendition: (
    item: LibraryItem,
    surface: "tile" | "viewer",
  ) => Promise<boolean>;
  /**
   * The item as this surface should paint it, resolved for a full screen.
   *
   * The tile's fields were computed against a box a couple of hundred pixels
   * wide, and this screen is five or ten times that. Called again after a fetch
   * lands, which is what stops the open item from going stale. See
   * `resolveForViewer`.
   */
  readonly onOpenForViewer: (item: LibraryItem) => Promise<LibraryItem>;
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
  /**
   * The viewer closed.
   *
   * The end of a viewing burst, which is the moment nothing is waiting on the
   * disk — so it is the cheapest time to run an eviction pass, and the phone has
   * just spent budget on whatever it fetched to show. See `reclaimAfterViewing`.
   */
  readonly onClosed: () => void;
}

/** The width the rows fill: the window less the list's own padding. */
export function libraryGridWidth(windowWidth: number): number {
  return windowWidth - CONTENT_PADDING * 2;
}

/**
 * The rows a page of records lays out as.
 *
 * Rows rather than tiles, because the list that draws them is virtualized and a
 * virtualized list windows whole items: one tile per item would let a list
 * unmount part of a visible row.
 *
 * How many go in a row is the layout's answer now rather than a constant — that
 * is what a justified grid decides — and it varies row by row with the shapes it
 * is given. A row of portraits holds more than a row of landscapes, which is the
 * point.
 *
 * Every item has an aspect ratio, including one whose dimensions nothing has
 * read: `displayedAspectOf` guesses a mild landscape rather than answering null,
 * so a library mid-backfill renders rather than gapping.
 */
export function libraryRows(
  items: readonly LibraryItem[],
  windowWidth: number,
): Array<JustifiedRow<LibraryItem>> {
  return layOutRows(items, (item) => item.aspect, {
    containerWidth: libraryGridWidth(windowWidth),
    targetRowHeight: LIBRARY_ROW_HEIGHT,
    gap: GRID_GAP,
  });
}

/** A stable key for a row: its first record, which never moves within the row. */
export function libraryRowKey(row: JustifiedRow<LibraryItem>): string {
  return row.placements[0]?.item.record.id ?? "empty";
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
  readonly row: JustifiedRow<LibraryItem>;
  readonly onOpen: (item: LibraryItem) => void;
}) {
  return (
    <View style={styles.gridRow}>
      {row.placements.map(({ item, width }) => (
        <Pressable
          key={item.record.id}
          onPress={() => onOpen(item)}
          // The box the layout assigned, and the same box `tileTarget` measured
          // the rendition request from. A style that carried a width fraction or
          // an aspect ratio of its own would be a second opinion about the
          // shape, and the two would disagree on every row.
          style={[styles.justifiedTile, { width, height: row.height }]}
        >
          <Image
            source={item.uri ? { uri: item.uri } : null}
            style={styles.tileImage}
            // **Cover, because the row has already decided what to crop.** A
            // justified row closes the gap between its photographs and the
            // container two ways: it scales the row, and it takes an equal
            // fraction off every photograph's width — `JustifiedRow.cropScale`,
            // which is below 1 on most rows of a real library. The box this tile
            // is given is the *cropped* box, so it is narrower than the
            // photograph's own shape at this height.
            //
            // `contain` refused that crop. Asked to fit a picture into a box
            // narrower than itself, it shrank the picture on both axes and left
            // the tile's own colour above and below — 3 to 12 points of it,
            // which is what made the space between rows look uneven when the
            // gap between them is a constant two. `cover` spends the difference
            // where the layout intended it, on the sides.
            contentFit="cover"
            // **The floor of the paint rule, and why no tile is ever empty.**
            // `expo-image` decodes the ThumbHash natively from this base64
            // string — no JavaScript decode, no data URL, no dependency — and
            // paints it until the real source resolves. A record with no
            // placeholder yet falls through to the tile's own background, which
            // is the state `backfillThumbHashes` removes.
            placeholder={item.thumbHash ? { thumbhash: item.thumbHash } : null}
            // The placeholder fills the tile rather than fitting inside it. A
            // ThumbHash is a blur, not a picture: letterboxing one would draw
            // attention to a stand-in that exists to be unnoticed, and there is
            // nothing in it to crop away.
            placeholderContentFit="cover"
            // **The recycling key, and it is not optional in a virtualized
            // list.** `expo-image` reuses the native view when a row scrolls
            // out and another takes its slot; without a key tying the view to
            // a record, the recycled view keeps painting the previous
            // photograph until the new one decodes. The symptom is a grid that
            // shows the wrong pictures for a frame or two during a fast
            // scroll, which reads as data corruption rather than as a decode.
            recyclingKey={item.record.id}
            // **Memory and disk, where this used to be disk alone.** The old
            // reasoning feared unbounded growth over a library of thousands,
            // and that is not what a memory cache is: Glide sizes an LRU from
            // the display and evicts against it, so the ceiling is a couple of
            // screens whether the library holds sixty photographs or sixty
            // thousand. What `disk` bought instead was a decode every time a
            // tile came back into the window — 100 to 250 ms per AVIF on a
            // Pixel 5 — which is the blank rectangle somebody sees scrolling
            // back up over pictures they were just looking at.
            cachePolicy="memory-disk"
            // A tile loses to a photograph somebody is waiting to look at.
            priority="low"
          />
          {/* The mark for a record with nothing on this device at all: no
              original and no rendition, so what is behind it is a ThumbHash or
              the tile's own colour. The fetch control in the viewer is what it
              exists for — eliding advances the watermark, so nothing in a sync
              round will offer those bytes again and that is the only route
              back. A video no longer lands here whenever its bytes are present:
              `expo-image` paints its first frame. */}
          {item.uri === null && !item.bytesHere ? (
            <View style={styles.tileMissingOverlay} pointerEvents="none">
              <Text style={styles.tilePlaceholderMark}>◇</Text>
            </View>
          ) : null}
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
}, sameRow);

/**
 * Whether two renderings of a row would draw the same thing.
 *
 * **`memo`'s default comparison is not enough here, because the row object is
 * never the same one twice.** A reload replaces `items` wholesale — that is what
 * it is for, since the URI a tile paints is derived from the object store and
 * re-deriving it is the only code path that produces one — and `libraryRows`
 * then builds fresh row and placement objects from the fresh items. Compared by
 * identity every row is new, so every row re-rendered and every `<Image>` was
 * handed a new `source`, which is a re-resolve and often a re-decode. A reload
 * that changed one tile redrew the whole grid.
 *
 * So the comparison is over what a tile actually draws with: which record, where
 * the pixels come from, how big the box is, and the marks. `thumbHash` is in
 * there because it is the placeholder, and it is exactly what a backfill pass
 * changes about a record that is otherwise untouched.
 */
function sameRow(
  before: { readonly row: JustifiedRow<LibraryItem>; readonly onOpen: unknown },
  after: { readonly row: JustifiedRow<LibraryItem>; readonly onOpen: unknown },
): boolean {
  if (before.onOpen !== after.onOpen) return false;
  if (before.row.height !== after.row.height) return false;
  if (before.row.placements.length !== after.row.placements.length) return false;
  return before.row.placements.every((placement, index) => {
    const other = after.row.placements[index];
    if (!other || placement.width !== other.width) return false;
    const a = placement.item;
    const b = other.item;
    return (
      a.record.id === b.record.id &&
      a.uri === b.uri &&
      a.thumbHash === b.thumbHash &&
      a.bytesHere === b.bytesHere &&
      a.hasMotion === b.hasMotion &&
      a.durationMs === b.durationMs
    );
  });
}

/**
 * The viewer's state, and the element that draws it.
 *
 * A hook rather than a component wrapping the grid, because the grid is no
 * longer a component that contains its tiles — the rows are items of a list the
 * screen owns. So the screen owns the viewer too, calls {@link open} from a row,
 * and renders {@link element} once, outside the list. Rendering it inside would
 * put a full-screen modal inside a recycled row.
 *
 * ## Why the whole page comes in, and not just the item that was tapped
 *
 * Swiping to the next photograph needs to know what the next photograph *is*,
 * and the only thing that knows the order is the list the grid is drawing —
 * `LIBRARY_ORDER`, applied by `listLibrary`. Passing the page in is what lets
 * the viewer step through it without inventing a second ordering that would
 * disagree with the grid the moment a record's capture time was backfilled.
 *
 * A swipe past the last loaded record does nothing rather than paging: the page
 * is what the grid has, and `loadMore` belongs to the list that scrolls.
 */
export function useLibraryViewer(
  {
    onFetch,
    onFetchRendition,
    onOpenForViewer,
    onSetPinned,
    isPinned,
    onOpened,
    onOpenMotion,
    onClosed,
  }: ViewerHost,
  items: readonly LibraryItem[],
): { open: (item: LibraryItem) => void; element: React.ReactElement } {
  const [item, setItem] = useState<LibraryItem | null>(null);
  /** The key currently being fetched, so the control can say so. */
  const [fetching, setFetching] = useState<string | null>(null);
  /** Pinned state of the open record, so the toggle is not a round trip. */
  const [pinned, setPinned] = useState(false);
  /**
   * Which record the viewer is showing, for the async work started on open.
   *
   * The resolve and the fetch both land after the tap, and either can land after
   * the viewer has been closed or opened on something else. Checking against
   * this before setting state is what stops one photograph's fetch from
   * replacing another's picture — a `setItem` from a stale open would show the
   * wrong record with no visible cause.
   */
  const showing = useRef<string | null>(null);
  /**
   * The page, readable from a callback that is not re-created when it changes.
   *
   * A dependency instead would rebuild {@link open} on every reload, and `open`
   * is what a row's `onPress` closes over — so the grid's rows would all
   * re-render for a list the viewer only reads when somebody swipes.
   */
  const pageRef = useRef(items);
  pageRef.current = items;

  const show = useCallback(
    (opened: LibraryItem) => {
      perf("show:enter");
      onOpened(opened.record.id);
      // **The rendition too, not only the parent.** Eviction is an LRU over
      // `last_opened_at_ms`, so a rung painted from disk that nothing ever
      // records as opened sorts with the never-opened rows — and the pass evicts
      // the very rendition the grid is drawing from. See
      // `LibraryItem.paintedRendition`.
      if (opened.paintedRendition) onOpened(opened.paintedRendition);
      perf("show:noted");
      setPinned(isPinned(opened.record.id));
      perf("show:pinned");
      showing.current = opened.record.id;
      // Opened on the tile's answer first, and improved a moment later. The
      // resolve is a database round trip, and a viewer that waited for one would
      // show a black screen for the length of it — where the tile's picture is
      // already decoded and already correct, just smaller than it could be.
      setItem(opened);
      perf("show:setItem");

      void (async () => {
        const resolved = await onOpenForViewer(opened);
        perf("show:resolved");
        if (showing.current !== opened.record.id) return;
        // **Only when it resolved to a different picture.** A record whose best
        // resident rung is the one the tile was already painting resolves to the
        // same URI, and setting it again is a re-render that hands `expo-image`
        // a fresh `source` object for bytes it has already decoded — a second
        // full-screen decode, and a second full-screen ThumbHash under it, for
        // no change on screen.
        if (!samePicture(resolved, opened)) setItem(resolved);
        // The rung this screen actually wants, which is usually not the one the
        // tile resolved. Not awaited by anything on screen: the viewer paints
        // what it has and improves when the bytes land.
        const arrived = await onFetchRendition(resolved, "viewer");
        perf(`show:renditionFetch arrived=${arrived}`);
        if (!arrived || showing.current !== opened.record.id) return;
        // **And this is what stops the open item going stale.** The fetch
        // changed what the store holds, and nothing else would tell the viewer:
        // it would go on painting the smaller rung and go on saying the bytes
        // are absent.
        const fetched = await onOpenForViewer(resolved);
        if (showing.current !== opened.record.id) return;
        if (!samePicture(fetched, resolved)) setItem(fetched);
      })();
    },
    [onOpened, isPinned, onOpenForViewer, onFetchRendition],
  );

  /** Where the open record sits in the page, or -1 once a reload has dropped it. */
  const indexOfOpen = (): number =>
    showing.current === null
      ? -1
      : pageRef.current.findIndex((candidate) => candidate.record.id === showing.current);

  const step = useCallback(
    (delta: ViewerStep) => {
      const index = indexOfOpen();
      if (index < 0) return;
      const next = pageRef.current[index + delta];
      // The ends of the page are where a swipe stops. Silently, because a
      // gesture that does nothing at the edge is what every gallery does, and
      // there is nothing to report.
      if (!next) return;
      show(next);
    },
    [show],
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

  const index = item ? items.findIndex((c) => c.record.id === item.record.id) : -1;

  const element = (
    <LibraryViewer
      item={item}
      busy={item !== null && fetching === item.record.id}
      pinned={pinned}
      hasPrevious={index > 0}
      hasNext={index >= 0 && index < items.length - 1}
      onStep={step}
      onTogglePin={(target) => setPinned(onSetPinned(target.record.id, !pinned))}
      onFetch={fetchNow}
      onOpenMotion={onOpenMotion}
      onClose={() => {
        perf("close:press");
        showing.current = null;
        setItem(null);
        perf("close:cleared");
        // **After the dismissal, not in front of it.** `onClosed` runs an
        // eviction pass, and calling it here ran it on the JavaScript thread
        // before React could render the unmount — half a second on a Pixel 5
        // between the tap on Close and the viewer going away. The pass is not
        // urgent and the dismissal is, so the interaction goes first.
        InteractionManager.runAfterInteractions(() => {
          void Promise.resolve(onClosed()).then(() => perf("close:reclaimed"));
        });
      }}
    />
  );

  return { open: show, element };
}

/**
 * Whether two resolutions of the same record would paint the same thing.
 *
 * Compared on what the viewer draws with rather than by identity, because
 * `resolveForViewer` builds a fresh object every time and most of the time it
 * has resolved to the rung the tile had already found. See {@link show}.
 */
function samePicture(a: LibraryItem, b: LibraryItem): boolean {
  return (
    a.record.id === b.record.id &&
    a.uri === b.uri &&
    a.playbackUri === b.playbackUri &&
    a.thumbHash === b.thumbHash &&
    a.bytesHere === b.bytesHere
  );
}
