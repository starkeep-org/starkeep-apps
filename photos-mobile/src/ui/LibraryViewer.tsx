/**
 * The photographs, full screen, one page each.
 *
 * Split out of `LibraryGrid` when the grid became virtualized. The two have
 * genuinely different lifetimes: a row is mounted and unmounted as it scrolls,
 * and the viewer must outlive every one of them — it is opened *from* a tile and
 * has to survive that tile being recycled out from under it while somebody is
 * looking at the picture.
 *
 * ## The frame and the pages
 *
 * The frame is fixed: a top bar with the back arrow, the pager, and a footer
 * with the info button and the Motion Photo toggle. The pages scroll inside it.
 * A horizontal `FlatList` with `pagingEnabled` is the pager, so Android's own
 * scroll view handles the drag: the photograph follows the finger, a fling
 * respects its speed, and the photographs either side are already mounted and
 * decoded when the swipe lands. The hand-rolled `PanResponder` this replaced
 * did none of the three, which is why a swipe so often seemed not to work.
 *
 * Only the page on screen is *active*. It alone resolves the rung the stage
 * wants, asks whether the photograph has motion, and plays anything; its
 * neighbours paint whatever the grid's tile already had.
 *
 * ## Why the bars never leave the layout
 *
 * `expo-image` on Android reloads an image whenever the view it draws into
 * changes size, and a reload of a photograph already on screen is a visible
 * blackout. So nothing the person does resizes the stage. The focused view, and
 * a playing video, hide the bars' *controls*; the bars keep their boxes, and
 * being black on black they disappear without moving the photograph. Only a
 * rotation resizes the stage. The pager keeps every page mounted across one, and
 * a resized `expo-image` view keeps drawing its old picture in one of its two
 * internal views until the reload lands in the other.
 *
 * ## Why a page's stage is three components rather than one body with three branches
 *
 * `useVideoPlayer` is a hook, so a component that holds one pays for it on every
 * render — and constructing a player is not free. Measured on a Pixel 5 against
 * an ordinary still photograph, two `ExoPlayerImpl.Init` lines landed 260 ms and
 * 335 ms after the tap. So a still mounts {@link StillStage}, which holds no
 * player at all; a video mounts {@link VideoStage} once somebody presses play;
 * and the clip inside a Motion Photo gets {@link MotionStage}, mounted only once
 * somebody asks for it.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  BackHandler,
  FlatList,
  InteractionManager,
  Pressable,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";
import { MaterialIcons } from "@expo/vector-icons";
// The only video player this app has. `expo-av` is not an option — the package
// is removed from SDK 54 onward — and React Native ships none of its own.
import { useVideoPlayer, VideoView } from "expo-video";
import { Image } from "expo-image";
import type { DataRecord, MetadataRow } from "@starkeep/protocol-primitives";
import type { LibraryItem } from "../library";
import type { Dimensions as Box } from "../photos/render-target";
import type { OpenMotionPhoto } from "../media/motion-photo-playback";
import { styles } from "./theme";
import { isVideo } from "./format";
import { perf } from "./perf";
import { PhotoInfoSheet } from "./PhotoInfoSheet";
import {
  collapseBelow,
  dropLayer,
  initialStack,
  markDisplayed,
  withUri,
  type LayerStack,
} from "./viewer-layers";

/** How close to the end of the loaded page a settled swipe asks for more. */
const LOAD_MORE_WITHIN = 5;

/**
 * How long a rung already on this device may go undrawn before the stage says
 * it is having trouble. A local rendition decodes in well under a second on a
 * Pixel 5, so two seconds is a picture that is not coming the ordinary way.
 */
const STALLED_AFTER_MS = 2000;

/** What the active page tells the frame, so the frame can draw its controls. */
interface PageReport {
  readonly id: string;
  /** Whether the photograph carries a Motion Photo clip. */
  readonly motion: boolean;
  /** Whether a video is playing right now. */
  readonly videoPlaying: boolean;
}

export function LibraryViewer({
  items,
  openId,
  resolved,
  stage,
  window,
  insets,
  landscape,
  focused,
  busyId,
  onSettle,
  onNearEnd,
  onToggleFocus,
  onPlay,
  onOpenMotion,
  onReadInfo,
  onDelete,
  onClose,
}: {
  /** The page the grid is drawing, in the grid's order. */
  readonly items: readonly LibraryItem[];
  /** The record on screen, or null while the viewer is closed. */
  readonly openId: string | null;
  /** Each record's viewer resolution, where one has landed. */
  readonly resolved: ReadonlyMap<string, LibraryItem>;
  /** The box the photograph gets, in layout points. See `viewerStageBox`. */
  readonly stage: Box;
  readonly window: Box;
  readonly insets: EdgeInsets;
  readonly landscape: boolean;
  /** Whether the focused view hides the controls. */
  readonly focused: boolean;
  /** The record whose video bytes are downloading, if any. */
  readonly busyId: string | null;
  /** A swipe came to rest on this record. */
  readonly onSettle: (id: string) => void;
  /** A swipe came to rest near the end of the loaded page. */
  readonly onNearEnd: () => void;
  readonly onToggleFocus: () => void;
  /** Play pressed on a clip: fetch what it needs to play, when that is not here. */
  readonly onPlay: (item: LibraryItem) => Promise<void>;
  readonly onOpenMotion: (item: LibraryItem) => Promise<OpenMotionPhoto | null>;
  readonly onReadInfo: (record: DataRecord) => Promise<MetadataRow | null>;
  readonly onDelete: (record: DataRecord) => Promise<void>;
  readonly onClose: () => void;
}) {
  /**
   * The hardware back button, which is the one thing `Modal` was doing for free.
   *
   * Registered whenever a record is open and removed when it is not, so the
   * button falls through to the grid's own handling while the grid is what is on
   * screen. The info sheet is a `Modal` and takes the button first while open.
   */
  const open = openId !== null;
  useEffect(() => {
    if (!open) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [open, onClose]);

  const [report, setReport] = useState<PageReport | null>(null);
  /** Whether the active page's Motion Photo clip is playing. Off on every page change. */
  const [playingMotion, setPlayingMotion] = useState(false);
  const [infoRecord, setInfoRecord] = useState<DataRecord | null>(null);
  useEffect(() => {
    setPlayingMotion(false);
  }, [openId]);

  const onReport = useCallback((next: PageReport) => {
    setReport((current) =>
      current &&
      current.id === next.id &&
      current.motion === next.motion &&
      current.videoPlaying === next.videoPlaying
        ? current
        : next,
    );
  }, []);
  const stopMotion = useCallback(() => setPlayingMotion(false), []);

  const index = openId === null ? -1 : items.findIndex((item) => item.record.id === openId);

  /**
   * Keeps the pager on the open record when the page shifts under it.
   *
   * A sync can land photographs ahead of the one on screen, which moves its
   * index. The pager scrolls by offset, so without this it would go on showing
   * whatever now sits at the old index.
   */
  const listRef = useRef<FlatList<LibraryItem>>(null);
  const shownIndex = useRef(index);
  useEffect(() => {
    if (index >= 0 && index !== shownIndex.current) {
      listRef.current?.scrollToIndex({ index, animated: false });
    }
    shownIndex.current = index;
  }, [index]);

  const pageWidth = window.width;
  /**
   * Back onto the open record after a rotation.
   *
   * A page is as wide as the window, so the offset the list held for the old
   * width points at a different record at the new one. The scroll waits for
   * the list to report content of the new width: scrolled any sooner, from a
   * layout effect, Android clamped the offset to the old, shorter content, and
   * landscape showed another photograph, or the halves of two.
   *
   * A stopgap. The pager still decides what is on screen from its offset; a
   * pager positioned from the open record would not need this at all.
   */
  const laidOutWidth = useRef(pageWidth);
  const onContentSizeChange = useCallback(
    (contentWidth: number) => {
      if (laidOutWidth.current === pageWidth) return;
      if (Math.abs(contentWidth - items.length * pageWidth) > 1) return;
      laidOutWidth.current = pageWidth;
      if (index >= 0) {
        listRef.current?.scrollToOffset({ offset: index * pageWidth, animated: false });
      }
    },
    [pageWidth, items.length, index],
  );
  const onMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const landed = Math.round(event.nativeEvent.contentOffset.x / pageWidth);
      const item = items[landed];
      if (!item) return;
      shownIndex.current = landed;
      onSettle(item.record.id);
      if (landed >= items.length - LOAD_MORE_WITHIN) onNearEnd();
    },
    [items, pageWidth, onSettle, onNearEnd],
  );

  const renderPage = useCallback(
    ({ item }: { item: LibraryItem }) => {
      const id = item.record.id;
      const active = id === openId;
      return (
        <ViewerPage
          item={resolved.get(id) ?? item}
          active={active}
          stage={stage}
          pageWidth={pageWidth}
          busy={busyId === id}
          playingMotion={active && playingMotion}
          onTapStill={onToggleFocus}
          onPlay={onPlay}
          onOpenMotion={onOpenMotion}
          onStopMotion={stopMotion}
          onReport={onReport}
        />
      );
    },
    [
      openId,
      resolved,
      stage,
      pageWidth,
      busyId,
      playingMotion,
      onToggleFocus,
      onPlay,
      onOpenMotion,
      stopMotion,
      onReport,
    ],
  );

  if (index < 0) return null;
  const current = items[index]!;
  const currentReport = report?.id === current.record.id ? report : null;
  // A video ignores the focused view: whether it is playing decides. A still
  // shows its controls unless the person tapped them away.
  const controlsVisible = isVideo(current) ? !currentReport?.videoPlaying : !focused;
  const fade = { opacity: controlsVisible ? 1 : 0 };
  const touchable = controlsVisible ? "auto" : "none";

  const back = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      onPress={onClose}
      style={styles.iconButton}
    >
      <MaterialIcons name="arrow-back" size={24} color="#fff" />
    </Pressable>
  );

  const pager = (
    <FlatList
      // **Not keyed on the page width.** A key remounted every page on a
      // rotation, and each new native view was empty until its first load
      // landed. The offsets go wrong instead, which `onContentSizeChange`
      // puts right once the list has resized.
      ref={listRef}
      data={items}
      horizontal
      pagingEnabled
      showsHorizontalScrollIndicator={false}
      keyExtractor={(item) => item.record.id}
      getItemLayout={(_data, i) => ({ length: pageWidth, offset: pageWidth * i, index: i })}
      initialScrollIndex={index}
      // The page on screen and one either side: enough that a swipe lands on a
      // photograph already decoded, few enough that three full-screen bitmaps
      // are the most this holds.
      windowSize={3}
      initialNumToRender={1}
      maxToRenderPerBatch={1}
      extraData={renderPage}
      renderItem={renderPage}
      onMomentumScrollEnd={onMomentumScrollEnd}
      onContentSizeChange={onContentSizeChange}
      style={{ height: stage.height, flexGrow: 0 }}
    />
  );

  return (
    // **A screen, not a dialog window.** `Modal` builds a second view hierarchy
    // and animates it in front of a screen this app already owns. This is a
    // full-bleed overlay in `HomeScreen`'s own tree instead, and the grid stays
    // mounted underneath, which is what keeps its scroll position and stops
    // every tile re-decoding on the way back.
    <View style={styles.viewerOverlay}>
      {/* **Every slot is present in both orientations, the pager at the same
          index.** The two layouts used to be two branches, and the pager sat
          first in one and third in the other, so React saw a different element
          at each position and remounted the pager on every rotation — every
          page's native view rebuilt empty, then reloaded as the window resized
          in steps. Nulls hold the places of what an orientation leaves out. */}
      {landscape ? null : <View style={{ height: insets.top }} />}
      {landscape ? null : (
        <View style={[styles.viewerTopBar, { paddingLeft: 4 + insets.left }]}>
          <View style={fade} pointerEvents={touchable}>
            {back}
          </View>
        </View>
      )}
      {pager}
      {/* Given the height the stage arithmetic reserved for it, so a control
          that is absent leaves its space empty rather than collapsing it
          and resizing the picture above. See `VIEWER_BAR_HEIGHT`. */}
      {landscape ? null : (
        <View style={[styles.viewerFooter, fade]} pointerEvents={touchable}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Photo info"
            onPress={() => setInfoRecord(current.record)}
            style={styles.iconButton}
          >
            <MaterialIcons name="info-outline" size={24} color="#fff" />
          </Pressable>
          {/* Offered only when there is genuinely motion in these bytes. The
              record stays one image everywhere else in the app — it sorts,
              syncs and counts as a single still — and this is the only place
              its bytes behave differently. */}
          {currentReport?.motion ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={playingMotion ? "Stop motion" : "Play motion"}
              onPress={() => setPlayingMotion((playing) => !playing)}
              style={[styles.iconButton, { flexDirection: "row", width: undefined, gap: 6, paddingHorizontal: 12 }]}
            >
              <MaterialIcons
                name={playingMotion ? "motion-photos-pause" : "motion-photos-on"}
                size={24}
                color="#fff"
              />
              <Text style={styles.viewerMotionLabel}>{playingMotion ? "Stop" : "Motion"}</Text>
            </Pressable>
          ) : null}
        </View>
      )}
      {landscape ? null : <View style={{ height: insets.bottom }} />}
      {/* The one control landscape keeps, bare over the photograph. */}
      {landscape && controlsVisible ? (
        <View style={[styles.viewerFloatingBack, { left: 4 + insets.left }]}>{back}</View>
      ) : null}
      <PhotoInfoSheet
        record={infoRecord}
        readInfo={onReadInfo}
        onDelete={onDelete}
        onClose={() => setInfoRecord(null)}
      />
    </View>
  );
}

/**
 * One photograph or clip, centred in a page as wide as the window.
 *
 * Memoized because the pager re-renders every mounted page whenever anything in
 * the frame changes, and a page whose props did not change has nothing to redo.
 */
const ViewerPage = memo(function ViewerPage({
  item,
  active,
  stage,
  pageWidth,
  busy,
  playingMotion,
  onTapStill,
  onPlay,
  onOpenMotion,
  onStopMotion,
  onReport,
}: {
  readonly item: LibraryItem;
  /** Whether this is the page on screen. Only the active page plays or probes. */
  readonly active: boolean;
  readonly stage: Box;
  readonly pageWidth: number;
  readonly busy: boolean;
  readonly playingMotion: boolean;
  readonly onTapStill: () => void;
  readonly onPlay: (item: LibraryItem) => Promise<void>;
  readonly onOpenMotion: (item: LibraryItem) => Promise<OpenMotionPhoto | null>;
  readonly onStopMotion: () => void;
  readonly onReport: (report: PageReport) => void;
}) {
  const { record, uri, bytesHere, playbackUri } = item;
  const clip = isVideo(item);

  /**
   * Whether somebody pressed play on this clip. The player mounts once this is
   * set and there is something to play, which may be after a download. Cleared
   * when the page stops being the one on screen, which unmounts the player — a
   * clip must not go on playing on a page somebody swiped away from.
   */
  const [playRequested, setPlayRequested] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  useEffect(() => {
    if (active) return;
    setPlayRequested(false);
    setVideoPlaying(false);
  }, [active]);
  const pressPlay = useCallback(() => {
    setPlayRequested(true);
    if (!playbackUri) void onPlay(item);
  }, [item, onPlay, playbackUri]);

  /**
   * The clip inside this photograph, if it is a Motion Photo.
   *
   * Opened when the page becomes active rather than when the control is
   * tapped, so the control can appear at all: whether a photograph has motion
   * is not knowable without asking, and a button that might do nothing is worse
   * than no button. Released when the page stops being active, and on the way
   * to the background — a scratch file lasts exactly one viewing by design.
   *
   * Not asked at all of a video record, and not asked of a neighbour page.
   *
   * ## Asked after the screen has settled, not while it is arriving
   *
   * A record the motion index has already covered answers in about 3 ms. One it
   * has not costs a whole-file read and a scan for XMP — 900 ms on a Pixel 5 for
   * a 1.6 MB JPEG — on the JavaScript thread. So the ask waits for the stage to
   * say it has something on screen, and `runAfterInteractions` then puts it in
   * an idle frame rather than inside the display callback itself.
   */
  const [motion, setMotion] = useState<OpenMotionPhoto | null>(null);
  const [painted, setPainted] = useState(false);
  const onPainted = useCallback(() => setPainted(true), []);
  useEffect(() => {
    if (clip || !painted || !active) return;
    let released = false;
    let handle: OpenMotionPhoto | null = null;
    const deferred = InteractionManager.runAfterInteractions(() => {
      // Cancelled and already-run race on a fast swipe, and `cancel()` does not
      // unschedule a task that has begun. The flag is what makes the late one
      // harmless.
      if (released) return;
      perf("motion:ask");
      void onOpenMotion(item).then((opened) => {
        perf(`motion:answered found=${opened !== null}`);
        handle = opened;
        // Opened after the page stopped being active. Hand the file straight
        // back rather than leave one nothing will ever collect but the start-up
        // sweep.
        if (released) opened?.release();
        else setMotion(opened);
      });
    });
    const background = AppState.addEventListener("change", (state) => {
      if (state === "active") return;
      onStopMotion();
      handle?.release();
      handle = null;
      released = true;
      setMotion(null);
    });
    return () => {
      released = true;
      deferred.cancel();
      background.remove();
      handle?.release();
      setMotion(null);
    };
    // The record, not the item: a resolution landing for the same record is a
    // new item object and must not close and reopen the clip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id, onOpenMotion, clip, painted, active, onStopMotion]);

  useEffect(() => {
    if (active) onReport({ id: record.id, motion: motion !== null, videoPlaying });
  }, [active, record.id, motion, videoPlaying, onReport]);

  const playingVideo = active && clip && playRequested && playbackUri;
  return (
    <View style={[styles.viewerPage, { width: pageWidth, height: stage.height }]}>
      <View style={{ width: stage.width, height: stage.height }}>
        {/* **Mounted under a playing clip, not replaced by it.** A player's view
            is empty until its first frame renders, so a clip that took the
            still's place showed black between the two. The clip draws over the
            still instead, transparent until that first frame, and the still is
            what is there again the moment the clip stops. */}
        <StillStage
          uri={uri}
          bytesHere={bytesHere}
          onPainted={onPainted}
          // A clip's poster plays on a tap; a still's tap toggles the focused
          // view.
          onTap={clip ? pressPlay : onTapStill}
        />
        {playingVideo ? (
          <VideoStage uri={playbackUri} onPlayingChange={setVideoPlaying} />
        ) : playingMotion && motion && uri ? (
          <MotionStage motion={motion} onStop={onStopMotion} />
        ) : null}
        {clip && !playingVideo ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={busy ? "Downloading the video" : "Play"}
            onPress={pressPlay}
            disabled={busy}
            style={styles.viewerPlayButton}
          >
            {busy ? (
              <Text style={styles.viewerPlayBusy}>Loading…</Text>
            ) : (
              <MaterialIcons name="play-arrow" size={40} color="#fff" />
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
});

/**
 * A photograph, or a clip's poster.
 *
 * Holds no player, which is the whole reason it is a component: this is what
 * most pages mount, and a still that constructs an `ExoPlayer` on the way in is
 * paying a quarter of a second for a video it does not have.
 *
 * The tap is a `Pressable` inside the pager's scroll view. A horizontal drag
 * that starts on the photograph hands the touch to the scroll view, which
 * cancels the press rather than firing it, so a swipe never counts as a tap.
 */
function StillStage({
  uri,
  bytesHere,
  onPainted,
  onTap,
}: {
  uri: string | null;
  bytesHere: boolean;
  /**
   * Called once this stage has drawn what it has, which is what releases the
   * body's background work. A stage with nothing to draw reports immediately —
   * there is no picture coming, so nothing is being waited for.
   */
  onPainted: () => void;
  onTap: () => void;
}) {
  const nothingToDraw = !uri;
  useEffect(() => {
    if (nothingToDraw) onPainted();
  }, [nothingToDraw, onPainted]);

  /**
   * The pictures on this stage, oldest first, one per rung.
   *
   * ## Why a mounted `Image`'s `source` never changes
   *
   * A page opens on whatever rung is here — the tile's, usually — and paints
   * again when its resolve finds a better one, or when a fetch or an encode
   * brings one down. The old shape pointed one `<Image>` at each rung in turn.
   * Re-pointing makes `expo-image` re-run its whole load against the live view,
   * which is the path that can fall back to the placeholder or, when a layout
   * pass reports zero size, clear the view outright. A resolution upgrade should
   * be a change of sharpness and nothing else, and that was the one thing it
   * visibly was not.
   *
   * So each rung gets an `<Image>` of its own, keyed on its URI, and a new one
   * mounts a new layer rather than re-pointing an existing one. The rules live
   * in `viewer-layers.ts`; the one that matters is that **a picture on screen
   * stays mounted and opaque until a newer layer has drawn above it.** An
   * incoming layer decodes at `opacity: 0`. On its `onDisplay` — which fires
   * once the native view holds the decoded picture, not when the bytes finished
   * loading — it turns opaque, and the layers beneath it unmount on the next
   * frame rather than on the same commit. Every layer draws `contain` in an
   * identical box, so the picture is in exactly the same place at every
   * resolution and the swap changes nothing but sharpness.
   *
   * ## Why no ThumbHash
   *
   * This screen drew the record's ThumbHash under the first rung for a while.
   * On a Pixel 10a it showed on every open as a frame or two of a blur that
   * looked nothing like the photograph, before the tile's rung — which decodes
   * almost as fast — replaced it. A stand-in that is visibly wrong is worse here
   * than a frame of the black backdrop. The grid keeps its ThumbHashes, where a
   * blur in a small square reads as a picture arriving.
   *
   * No transition and no cross-fade: the resolution changes between two frames.
   */
  const [stack, setStack] = useState<LayerStack>(() => initialStack(uri));
  useEffect(() => {
    // A page whose URI goes away keeps what it drew. The picture is decoded
    // and on screen, and an empty stage would be the one thing worse.
    if (uri) setStack((current) => withUri(current, uri));
  }, [uri]);

  // Mounts and unmounts, for the timing log: a stage that remounts during a
  // swipe starts empty, and that is a flicker no layer rule can prevent.
  const firstUri = useRef(uri);
  useEffect(() => {
    perf(`stage:mount ${layerTag(firstUri.current)}`);
    return () => perf(`stage:unmount ${layerTag(firstUri.current)}`);
  }, []);

  /**
   * One `source` object per layer, for the lifetime of this stage.
   *
   * Native `expo-image` compares sources by value, so a fresh literal would not
   * reload a layer today. Kept stable anyway: React's prop diff then has nothing
   * to send for a layer that has not changed, and a layer that has not changed
   * is the whole design.
   */
  const sources = useRef(new Map<string, { uri: string }>());
  const sourceFor = useCallback((layer: string) => {
    let source = sources.current.get(layer);
    if (!source) sources.current.set(layer, (source = { uri: layer }));
    return source;
  }, []);

  /**
   * The collapse a frame after each display, cancelled with the stage.
   *
   * `onDisplay` fires once the native view holds the picture, which is not the
   * same as a frame having shown it. Turning the layer opaque and unmounting the
   * one beneath on the same commit would rely on the two landing in one frame;
   * a frame apart, the layer beneath is still there if they do not.
   */
  const frames = useRef(new Set<number>());
  useEffect(() => {
    const pending = frames.current;
    return () => pending.forEach((frame) => cancelAnimationFrame(frame));
  }, []);

  const onDisplayed = useCallback(
    (layer: string) => {
      perf(`image:display ${layerTag(layer)}`);
      setStack((current) => markDisplayed(current, layer));
      const frame = requestAnimationFrame(() => {
        frames.current.delete(frame);
        setStack((current) => collapseBelow(current, layer));
      });
      frames.current.add(frame);
      onPainted();
    },
    [onPainted],
  );

  /**
   * A rung that will not decode leaves the stack, and whatever is beneath it
   * stays. It still settles the stage, so the body's deferred work never waits
   * on a picture that is not coming.
   */
  const [failed, setFailed] = useState(false);
  const onFailed = useCallback(
    (layer: string) => {
      perf(`image:error ${layerTag(layer)}`);
      setStack((current) => dropLayer(current, layer));
      setFailed(true);
      onPainted();
    },
    [onPainted],
  );

  /**
   * Whether a rung that is on this device has gone unseen for too long.
   *
   * Armed only while the stack holds a rung and none has drawn: a rung in the
   * stack is a file on this device, and a local file decodes in a fraction of
   * a second. A page waiting on a fetch has no rung yet and no timer, because
   * the fetch has its own state. A timer, not a wait — the stage goes on
   * drawing whatever it has, and the note only says so.
   */
  const shown = stack.displayed.size > 0;
  const pending = stack.layers.some((layer) => !stack.displayed.has(layer));
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!pending || shown) return;
    const timer = setTimeout(() => {
      perf("image:stalled");
      setStalled(true);
    }, STALLED_AFTER_MS);
    return () => clearTimeout(timer);
  }, [pending, shown]);
  const troubled = !shown && (stalled || (failed && !pending));

  return (
    <View style={styles.viewerStage}>
      <Pressable style={styles.viewerImageArea} onPress={onTap}>
        {stack.layers.length > 0 || failed ? (
          <>
            {stack.layers.map((layer, index) => (
              <Image
                // **Keyed on its own URI**, which is what makes this a new mount
                // rather than a re-point. See the layer stack above.
                key={layer}
                source={sourceFor(layer)}
                // A layer over another is transparent until it has drawn, so it
                // never covers a picture with nothing. The bottom layer has
                // nothing beneath it to cover, and an empty `expo-image` view
                // draws nothing, so it is opaque from the start: waiting for
                // `onDisplay` there only added a trip through JavaScript —
                // a frame or two of black backdrop on every open — after the
                // native view already held the picture.
                style={[
                  styles.viewerImage,
                  { opacity: index === 0 || stack.displayed.has(layer) ? 1 : 0 },
                ]}
                contentFit="contain"
                // Memory, unlike the grid's tiles. One picture at a time, and
                // re-decoding a full-size rendition every time somebody swipes
                // back to it is exactly the cost worth paying once.
                cachePolicy="memory-disk"
                // The opposite of the tile's. Whatever is on this screen is the
                // thing somebody is waiting for.
                priority="high"
                onLoadStart={() => perf(`image:loadStart ${layerTag(layer)}`)}
                onLoad={(event) =>
                  perf(
                    `image:load ${layerTag(layer)} ${event.source.width}x${event.source.height} cache=${event.cacheType}`,
                  )
                }
                onDisplay={() => onDisplayed(layer)}
                onError={() => onFailed(layer)}
              />
            ))}
            {troubled ? (
              <View style={styles.viewerStallNote} pointerEvents="none">
                <Text style={styles.viewerStallText}>Having trouble loading this photo</Text>
              </View>
            ) : null}
          </>
        ) : bytesHere ? (
          // A record whose bytes are here and which has no still to draw and
          // nothing to play. Not a video — those take the branch above — so
          // this is a type this app cannot display, which is a real state
          // and a different one from missing bytes.
          <Text style={styles.muted}>
            Starkeep holds this record&rsquo;s bytes and has nothing to show for them.
          </Text>
        ) : (
          <Text style={styles.muted}>This record&rsquo;s bytes are not on this device.</Text>
        )}
      </Pressable>
    </View>
  );
}

/**
 * The end of a layer's URI, enough to tell rungs and records apart in the
 * timing log without writing whole paths into it.
 */
function layerTag(uri: string | null): string {
  return uri ? uri.slice(-24) : "none";
}

/**
 * A video record, with the platform's own controls.
 *
 * Not inside a `Pressable`: every tap on a player is aimed at the player's own
 * controls. The pager still pages on a horizontal drag; Android's `SeekBar`
 * keeps a drag that starts on the scrubber from reaching the scroll view.
 *
 * **Mounted only after somebody pressed play**, so it starts playing at once.
 * The viewer opens on the clip's poster with a play button over it: a video
 * that starts making noise because a tile was tapped is a surprise, and a
 * download nobody asked for spends somebody's data.
 */
function VideoStage({
  uri,
  onPlayingChange,
}: {
  uri: string;
  /** Whether the clip is playing, so the frame can hide its controls. */
  onPlayingChange: (playing: boolean) => void;
}) {
  /**
   * `contentType: "progressive"` is stated rather than left to inference, and
   * the reason is a file with no extension. A blob fetched from the cloud lands
   * at `shared/video/<shard>/<hash>`, and ExoPlayer's default source factory
   * infers the container from the URI before it falls back to sniffing — so a
   * clip that plays perfectly when imported from the camera roll would be the
   * one that fails after arriving by sync.
   */
  const player = useVideoPlayer({ uri, contentType: "progressive" as const }, (p) => {
    p.loop = false;
    p.play();
  });
  // Read from the player's own event rather than from the controls, because
  // the native controls pause and resume without telling this app otherwise.
  useEffect(() => {
    onPlayingChange(player.playing);
    const subscription = player.addListener("playingChange", ({ isPlaying }) =>
      onPlayingChange(isPlaying),
    );
    return () => {
      subscription.remove();
      onPlayingChange(false);
    };
  }, [player, onPlayingChange]);
  const [rendered, setRendered] = useState(false);
  return (
    // Over the poster, transparent until the first frame. See `clipOver`.
    <View style={clipOver(rendered)}>
      {/* `nativeControls` rather than controls of this app's own: play,
          scrub and the fullscreen button are the platform's, which is what
          makes them behave the way every other video on the device does.
          Fullscreen is enabled by default and is not restated here. */}
      <VideoView
        player={player}
        style={styles.viewerImage}
        nativeControls
        contentFit="contain"
        onFirstFrameRender={() => setRendered(true)}
      />
    </View>
  );
}

/**
 * The clip inside a Motion Photo, playing.
 *
 * Mounted only while it plays, which is what keeps its player off the cost of
 * opening an ordinary photograph — most stills are not Motion Photos, and of
 * those that are, most are never asked to move.
 *
 * No controls, unlike a video record's player. This is a photograph that moves,
 * not a clip to scrub: the gesture is tap to see it and tap again to stop, and a
 * scrubber over a second-and-a-half loop is furniture nobody wants.
 */
function MotionStage({ motion, onStop }: { motion: OpenMotionPhoto; onStop: () => void }) {
  /**
   * Seeked to the frame that is the photograph.
   *
   * `presentationTimestampUs` is where the still sits inside the clip, and
   * starting there is what makes the swap seamless: the first frame the player
   * shows is the one already on screen, and what follows is what happened next.
   * Starting at zero would jump backwards by a second and a half, which reads as
   * a glitch rather than as motion.
   */
  const player = useVideoPlayer(
    { uri: motion.uri, contentType: "progressive" as const },
    (p) => {
      p.loop = true;
      if (motion.presentationTimestampUs) {
        p.currentTime = motion.presentationTimestampUs / 1_000_000;
      }
      p.play();
    },
  );
  const [rendered, setRendered] = useState(false);
  return (
    <Pressable style={clipOver(rendered)} onPress={onStop}>
      <VideoView
        player={player}
        style={styles.viewerImage}
        contentFit="contain"
        nativeControls={false}
        onFirstFrameRender={() => {
          perf("motion:firstFrame");
          setRendered(true);
        }}
      />
    </Pressable>
  );
}

/**
 * A player laid over the still it plays from, transparent until its first frame.
 *
 * `expo-video` already hides its own surface until that frame, so this is a
 * second guard rather than the only one: the player's view, its controls and
 * anything the platform paints behind them stay invisible until there is a
 * frame to show, and until then the still beneath is what is on screen.
 */
function clipOver(rendered: boolean) {
  return [styles.viewerImage, { opacity: rendered ? 1 : 0 }];
}
