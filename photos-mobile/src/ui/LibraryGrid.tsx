/**
 * The node's library, and a photo you can open.
 *
 * These are the node's records rather than the device's camera roll. On a
 * phone that has imported its camera roll the pictures are the same; the
 * difference is that these are things Starkeep holds — hashed, addressed, and
 * ready to sync.
 *
 * ## Square tiles, two across
 *
 * Every photograph is a centre crop in a square tile, two to a row in
 * portrait and four in landscape. Each tile
 * has the same box, so the rendition request is the same rule for every
 * record: `photos/render-target.ts`'s `gridTileTarget` measures the crop with
 * `cover`. See `grid-geometry.ts`'s `libraryColumns`.
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
 * its first frame and never autoplaying. A **still** gets an `<Image>`, and a tap
 * on it toggles the focused view. A **Motion Photo** is a still until somebody asks: it is
 * one image record whose bytes happen to carry a trailing MP4, and the control
 * that plays it materialises a scratch file for that viewing and deletes it
 * afterwards. See `media/motion-photo-playback.ts` for why nothing is kept.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import type { DataRecord, MetadataRow } from "@starkeep/protocol-primitives";
import type { LibraryItem } from "../library";
import type { OpenMotionPhoto } from "../media/motion-photo-playback";
import { viewerStageBox, type Dimensions as Box } from "../photos/render-target";
import { libraryTileSize, styles } from "./theme";
import { MotionBadge } from "./MotionBadge";
import { VideoBadge } from "./VideoBadge";
import { LibraryViewer } from "./LibraryViewer";
import type { CaptionStore } from "../photos/captions";
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
   * Make this record's missing rungs, because a surface cannot paint one.
   *
   * The viewer's counterpart to {@link onFetchRendition}, and the distinction is
   * which node owns the original: a rung that exists somewhere wants bytes
   * moved, and one nothing has derived wants work commissioned. The ceiling is
   * the rung this surface needs, which for a full screen is above what a
   * background sweep will spend the memory on.
   */
  readonly onDeriveNow: (
    item: LibraryItem,
    surface: "tile" | "viewer",
    ceilingLongEdge?: number,
  ) => Promise<boolean>;
  /**
   * The item as this surface should paint it, resolved for a full screen.
   *
   * The tile's fields were computed against a box a couple of hundred pixels
   * wide, and this screen is five or ten times that. Called again after a fetch
   * lands, which is what stops the open item from going stale. See
   * `resolveForViewer`.
   *
   * The stage is passed rather than looked up, because the box the photograph
   * gets is the viewer's own arithmetic and the request has to be measured
   * against exactly the box the style sheet lays out. See `viewerStageBox`.
   */
  readonly onOpenForViewer: (item: LibraryItem, stage: Box) => Promise<LibraryItem>;
  /**
   * The clip inside a Motion Photo, materialised for one viewing.
   *
   * Answers null for the ordinary photograph, which is most of them — the viewer
   * simply shows no motion control. The handle it does answer must be released
   * when the viewer closes; the scratch file lasts exactly one viewing by design.
   */
  readonly onOpenMotion: (item: LibraryItem) => Promise<OpenMotionPhoto | null>;
  /** The record's metadata row, for the info sheet. See `useLibrary().readInfo`. */
  readonly onReadInfo: (record: DataRecord) => Promise<MetadataRow | null>;
  /** Delete the record everywhere, from the info sheet. See `useLibrary().deleteRecord`. */
  readonly onDelete: (record: DataRecord) => Promise<void>;
  /** Photos' captions, for the viewer and its info sheet. See `useLibrary().captions`. */
  readonly captions?: CaptionStore | null;
  /** Load the next page, because a swipe came to rest near the end of this one. */
  readonly onLoadMore: () => void;
}

/** One row of the library grid: up to `libraryColumns` square tiles. */
export interface LibraryGridRow {
  readonly items: readonly LibraryItem[];
  /** The side of every tile in the row, in layout points. */
  readonly tileSize: number;
}

/**
 * The rows a page of records lays out as.
 *
 * Rows rather than tiles, because the list that draws them is virtualized and a
 * virtualized list windows whole items: one tile per item would let a list
 * unmount half of a visible row.
 */
export function libraryRows(
  items: readonly LibraryItem[],
  gridWidth: number,
  columns: number,
): LibraryGridRow[] {
  const tileSize = libraryTileSize(gridWidth, columns);
  const rows: LibraryGridRow[] = [];
  for (let at = 0; at < items.length; at += columns) {
    rows.push({ items: items.slice(at, at + columns), tileSize });
  }
  return rows;
}

/** A stable key for a row: its first record, which never moves within the row. */
export function libraryRowKey(row: LibraryGridRow): string {
  return row.items[0]?.record.id ?? "empty";
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
  readonly row: LibraryGridRow;
  readonly onOpen: (item: LibraryItem) => void;
}) {
  return (
    <View style={styles.gridRow}>
      {row.items.map((item) => (
        <Pressable
          key={item.record.id}
          onPress={() => onOpen(item)}
          // The same square `gridTileTarget` measured the rendition request
          // from, so the layout and the request agree about the box.
          style={[styles.gridTile, { width: row.tileSize, height: row.tileSize }]}
        >
          <Image
            source={item.uri ? { uri: item.uri } : null}
            style={styles.tileImage}
            // A centre crop: the tile is square and the photograph is not.
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
              the tile's own colour. Opening it is the route back — the viewer
              fetches the rung it needs, or a clip's copy on play — because
              eliding advances the watermark, so nothing in a sync round will
              offer those bytes again.

              **Both halves of the condition are load-bearing now that the list
              paints rungs only.** A null `uri` on its own no longer means
              anything is wrong — it is the ordinary state of a photograph out of
              this device's own camera roll that nothing has derived yet, which
              wants a ThumbHash and a derivation rather than a mark saying its
              bytes are elsewhere. `bytesHere` is what separates the two. */}
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
  before: { readonly row: LibraryGridRow; readonly onOpen: unknown },
  after: { readonly row: LibraryGridRow; readonly onOpen: unknown },
): boolean {
  if (before.onOpen !== after.onOpen) return false;
  if (before.row.tileSize !== after.row.tileSize) return false;
  if (before.row.items.length !== after.row.items.length) return false;
  return before.row.items.every((a, index) => {
    const b = after.row.items[index];
    if (!b) return false;
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
 * and renders {@link element} once, outside the list.
 *
 * ## Why the whole page comes in, and not just the item that was tapped
 *
 * The pager pages through what the grid is drawing, in the grid's order —
 * `LIBRARY_ORDER`, applied by `listLibrary`. Passing the page in is what lets
 * the viewer move through it without inventing a second ordering that would
 * disagree with the grid the moment a record's capture time was backfilled. A
 * swipe that lands near the end of the page asks the library for the next one.
 *
 * ## State that outlives a page
 *
 * The focused view survives swipes and rotations: it is a choice about how to
 * look at photographs, not about one photograph. Each record's resolution is
 * kept while the viewer is open, so swiping back to a photograph paints the
 * rung it already resolved rather than the tile's.
 */
export function useLibraryViewer(
  {
    onFetch,
    onFetchRendition,
    onDeriveNow,
    onOpenForViewer,
    onOpenMotion,
    onReadInfo,
    onDelete,
    captions = null,
    onLoadMore,
  }: ViewerHost,
  items: readonly LibraryItem[],
): { open: (item: LibraryItem) => void; element: React.ReactElement } {
  /**
   * The box the photograph gets, computed once and read by two things that must
   * not disagree: the style sheet that lays the stage out, and the rendition
   * request measured against it.
   *
   * `useWindowDimensions` rather than `Dimensions.get` because a rotation has to
   * re-render — it is the one event that should resize the stage, and the only
   * one.
   */
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const landscape = window.width > window.height;
  const stage = useMemo(
    () => viewerStageBox({ width: window.width, height: window.height }, insets, landscape),
    [window.width, window.height, insets, landscape],
  );
  /**
   * The stage, readable from a callback that does not rebuild when it changes.
   *
   * {@link open} closes over the resolve, and `open` is what a row's `onPress`
   * holds — so a dependency would re-render every tile in the grid on a rotation.
   */
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const [openId, setOpenId] = useState<string | null>(null);
  /** Each visited record's resolution for this stage, while the viewer is open. */
  const [resolved, setResolved] = useState<ReadonlyMap<string, LibraryItem>>(() => new Map());
  const [focused, setFocused] = useState(false);
  /** The key currently being fetched, so the control can say so. */
  const [fetching, setFetching] = useState<string | null>(null);
  /**
   * Which record the viewer is showing, for the async work started on a page.
   *
   * The resolve and the fetch both land after the page settles, and either can
   * land after the viewer has closed or moved on. Checking against this before
   * setting state is what stops one photograph's fetch from replacing another's
   * picture.
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

  /** Record a resolution, unless it paints what is already recorded. */
  const remember = useCallback((item: LibraryItem) => {
    setResolved((current) => {
      const known = current.get(item.record.id);
      if (known && samePicture(known, item)) return current;
      const next = new Map(current);
      next.set(item.record.id, item);
      return next;
    });
  }, []);

  /** The latest resolutions, readable from a callback without rebuilding it. */
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;

  /** The rung this stage wants for one record, among the ones already here. */
  const resolveNow = useCallback(
    (base: LibraryItem): Promise<LibraryItem> => onOpenForViewer(base, stageRef.current),
    [onOpenForViewer],
  );

  /**
   * Fetch or derive the rung this stage wants when it is not here, and repaint
   * the page once it lands. Only ever run for the page on screen.
   */
  const improve = useCallback(
    (current: LibraryItem) => {
      const id = current.record.id;
      // A clip downloads nothing on open. Its bytes move when somebody presses
      // play, which is `playNow`'s job.
      if (isVideo(current)) return;
      void (async () => {
        // **Two ways to get the rung this screen wants, and a record is only
        // ever in one of them.** `missingRendition` is non-null exactly when the
        // rung's record exists and its bytes do not, which is a transfer. Null
        // with the ideal unpainted is the opposite state — nothing has derived
        // it anywhere — and on a phone showing its own camera roll that is the
        // ordinary case, because the sweep's ceiling stops at `image-medium` and
        // this stage wants more.
        const improved =
          current.missingRendition !== null
            ? await onFetchRendition(current, "viewer")
            : await onDeriveNow(current, "viewer", current.renditionTarget ?? undefined);
        perf(`show:improve arrived=${improved}`);
        if (!improved || showing.current !== id) return;
        // **And this is what stops the page going stale.** The fetch or the
        // encode changed what the store holds, and nothing else would tell the
        // viewer.
        const better = await resolveNow(current);
        if (showing.current !== id) return;
        if (!samePicture(better, current)) remember(better);
      })();
    },
    [onFetchRendition, onDeriveNow, resolveNow, remember],
  );

  /**
   * Resolve the photographs either side of the one on screen, before anybody
   * swipes to them.
   *
   * A neighbour's page is already mounted, painting the tile's rung. Resolving
   * it now means the swap to the right rung happens off screen, and a swipe
   * lands on the photograph at the size it will stay at.
   */
  const resolveNeighbours = useCallback(
    (id: string, { force = false }: { force?: boolean } = {}) => {
      const page = pageRef.current;
      const at = page.findIndex((candidate) => candidate.record.id === id);
      for (const neighbour of [page[at - 1], page[at + 1]]) {
        if (!neighbour) continue;
        if (!force && resolvedRef.current.has(neighbour.record.id)) continue;
        void resolveNow(neighbour).then((item) => {
          if (showing.current !== null) remember(item);
        });
      }
    },
    [resolveNow, remember],
  );

  /**
   * Open the viewer on a record, on the tap, with whatever is here.
   *
   * **Nothing waits.** The viewer opens on the tile's rung and its ThumbHash,
   * and the resolve for the rung the stage wants runs behind it. A better rung
   * mounts as a layer of its own and covers the tile's once it has drawn — see
   * `StillStage` — so the swap changes sharpness and nothing else. The tap used
   * to wait up to 150 ms for the resolve, because a swap then showed as a
   * blackout. A swap that cannot black out is cheaper than any wait.
   */
  const open = useCallback(
    (opened: LibraryItem) => {
      const id = opened.record.id;
      perf(`show:enter ${id.slice(-6)}`);
      showing.current = id;
      setResolved(new Map());
      setFocused(false);
      setOpenId(id);
      void (async () => {
        const current = await resolveNow(opened);
        perf(`show:resolved better=${!samePicture(current, opened)}`);
        if (showing.current !== id) return;
        remember(current);
        improve(current);
        resolveNeighbours(id);
      })();
    },
    [resolveNow, improve, resolveNeighbours, remember],
  );

  /** A swipe came to rest on a record: it becomes the one being shown. */
  const settle = useCallback(
    (id: string) => {
      if (showing.current === id) return;
      const base = pageRef.current.find((candidate) => candidate.record.id === id);
      if (!base) return;
      perf(`settle ${id.slice(-6)}`);
      showing.current = id;
      setOpenId(id);
      const known = resolvedRef.current.get(id);
      void (async () => {
        const current = known ?? (await resolveNow(base));
        if (showing.current !== id) return;
        if (!known) remember(current);
        improve(current);
        resolveNeighbours(id);
      })();
    },
    [resolveNow, improve, resolveNeighbours, remember],
  );

  // A rotation changes the stage, and the rung a landscape photograph wants on a
  // landscape screen is larger. Resolve the page on screen and its neighbours
  // again for the new box.
  //
  // The earlier resolutions stay until the new ones land. Clearing them sent
  // every page back to the tile's rung for a moment, and a window resizes in two
  // steps on a rotation, so a second clear could land after the first
  // resolution and send the page back again.
  //
  // Keyed on the stage's size alone. The callbacks are read through a ref,
  // because a dependency on them would rerun this whenever the library rebuilt
  // one, and that would throw away every resolution mid-viewing.
  const rotationWork = useRef({ resolveNow, remember, improve, resolveNeighbours });
  rotationWork.current = { resolveNow, remember, improve, resolveNeighbours };
  const firstStage = useRef(true);
  useEffect(() => {
    if (firstStage.current) {
      firstStage.current = false;
      return;
    }
    const id = showing.current;
    if (id === null) return;
    const base = pageRef.current.find((candidate) => candidate.record.id === id);
    if (!base) return;
    const work = rotationWork.current;
    void work.resolveNow(base).then((current) => {
      if (showing.current !== id) return;
      work.remember(current);
      work.improve(current);
      work.resolveNeighbours(id, { force: true });
    });
  }, [stage.width, stage.height]);

  const close = useCallback(() => {
    perf("close:press");
    showing.current = null;
    setOpenId(null);
    setResolved(new Map());
  }, []);

  // A reload that dropped the open record — deleted elsewhere and synced in —
  // leaves nothing to show.
  useEffect(() => {
    if (openId !== null && !items.some((item) => item.record.id === openId)) close();
  }, [items, openId, close]);

  const toggleFocus = useCallback(() => setFocused((current) => !current), []);

  /**
   * Play pressed on a clip whose bytes are not here: fetch the copy the viewer
   * chose, or the original when no copy exists, then resolve again so the
   * viewer has something to play.
   *
   * The copy is the smallest one covering the stage. See
   * `photos/video-playback.ts`. The original moves only for a clip nobody has
   * transcoded.
   */
  const playNow = useCallback(
    async (target: LibraryItem): Promise<void> => {
      if (target.playbackUri) return;
      setFetching(target.record.id);
      try {
        const fetched =
          target.missingRendition !== null
            ? await onFetchRendition(target, "viewer")
            : await onFetch(target);
        if (!fetched || showing.current !== target.record.id) return;
        const playable = await onOpenForViewer(target, stageRef.current);
        if (showing.current !== target.record.id) return;
        remember(playable);
      } finally {
        setFetching(null);
      }
    },
    [onFetch, onFetchRendition, onOpenForViewer, remember],
  );

  const element = (
    <LibraryViewer
      items={items}
      openId={openId}
      resolved={resolved}
      stage={stage}
      window={{ width: window.width, height: window.height }}
      insets={insets}
      landscape={landscape}
      focused={focused}
      busyId={fetching}
      onSettle={settle}
      onNearEnd={onLoadMore}
      onToggleFocus={toggleFocus}
      onPlay={playNow}
      onOpenMotion={onOpenMotion}
      onReadInfo={onReadInfo}
      onDelete={onDelete}
      captions={captions}
      onClose={close}
    />
  );

  return { open, element };
}

/**
 * Whether two resolutions of the same record would paint the same thing.
 *
 * Compared on what the viewer draws with rather than by identity, because
 * `resolveForViewer` builds a fresh object every time and most of the time it
 * has resolved to the rung the tile had already found. See {@link open}.
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
