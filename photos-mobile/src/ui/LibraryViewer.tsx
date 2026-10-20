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
 * rotation resizes the stage, and a rotation redraws everything anyway.
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

/** How close to the end of the loaded page a settled swipe asks for more. */
const LOAD_MORE_WITHIN = 5;

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
      // Remounted on rotation, at the open record. A page's width is the
      // window's, so every offset the old list held is wrong afterwards.
      key={`pager-${pageWidth}`}
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
      {landscape ? (
        <>
          {pager}
          {/* The one control landscape keeps, bare over the photograph. */}
          {controlsVisible ? (
            <View style={[styles.viewerFloatingBack, { left: 4 + insets.left }]}>{back}</View>
          ) : null}
        </>
      ) : (
        <>
          <View style={{ height: insets.top }} />
          <View style={[styles.viewerTopBar, { paddingLeft: 4 + insets.left }]}>
            <View style={fade} pointerEvents={touchable}>
              {back}
            </View>
          </View>
          {pager}
          {/* Given the height the stage arithmetic reserved for it, so a control
              that is absent leaves its space empty rather than collapsing it
              and resizing the picture above. See `VIEWER_BAR_HEIGHT`. */}
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
          <View style={{ height: insets.bottom }} />
        </>
      )}
      <PhotoInfoSheet
        record={infoRecord}
        readInfo={onReadInfo}
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
  const { record, uri, bytesHere, playbackUri, thumbHash } = item;
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
        {playingVideo ? (
          <VideoStage uri={playbackUri} onPlayingChange={setVideoPlaying} />
        ) : playingMotion && motion && uri ? (
          <MotionStage motion={motion} onStop={onStopMotion} />
        ) : (
          <StillStage
            uri={uri}
            thumbHash={thumbHash}
            bytesHere={bytesHere}
            onPainted={onPainted}
            // A clip's poster plays on a tap; a still's tap toggles the focused
            // view.
            onTap={clip ? pressPlay : onTapStill}
          />
        )}
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
  thumbHash,
  bytesHere,
  onPainted,
  onTap,
}: {
  uri: string | null;
  thumbHash: string | null;
  bytesHere: boolean;
  /**
   * Called once this stage has drawn what it has, which is what releases the
   * body's background work. A stage with nothing to draw reports immediately —
   * there is no picture coming, so nothing is being waited for.
   */
  onPainted: () => void;
  onTap: () => void;
}) {
  const nothingToDraw = !uri && !thumbHash;
  useEffect(() => {
    if (nothingToDraw) onPainted();
  }, [nothingToDraw, onPainted]);

  /**
   * The pictures on this stage, oldest first, each one a rung.
   *
   * ## Why a mounted `Image`'s `source` never changes
   *
   * A page opens on the rung its resolve found, and paints again only when a
   * fetch or an encode brings down a better one — or, on a neighbour page, when
   * its resolve lands after the page mounted on the tile's rung. The old shape
   * pointed one `<Image>` at each rung in turn. Re-pointing makes
   * `expo-image` re-run its whole load against the live view, which is the path
   * that can fall back to the placeholder or, when a layout pass reports zero
   * size, clear the view outright. A resolution upgrade should be a change of
   * sharpness and nothing else, and that was the one thing it visibly was not.
   *
   * So each rung gets an `<Image>` of its own, keyed on its URI, and a new rung
   * mounts a new layer rather than re-pointing an existing one. The incoming
   * layer decodes at `opacity: 0` behind nothing; on its `onDisplay` — which
   * fires when the view has actually rendered the picture, not when the bytes
   * finished loading — it goes opaque and everything beneath it unmounts on the
   * same commit. Both layers draw `contain` in an identical box, so the picture
   * is in exactly the same place at both resolutions and the swap changes
   * nothing but sharpness.
   *
   * No transition and no cross-fade: the resolution changes between two frames.
   */
  const [layers, setLayers] = useState<readonly string[]>(() => (uri ? [uri] : []));
  /** The layer that has actually rendered, which is the one allowed to be opaque. */
  const [shown, setShown] = useState<string | null>(null);
  /**
   * The layer that carries the ThumbHash: the first one this stage mounted, for
   * as long as it stays mounted.
   *
   * **Fixed for the layer's whole life, because `expo-image` reloads on a
   * placeholder change.** On Android `ExpoImageViewWrapper.rerenderIfNeeded`
   * treats a new placeholder exactly like a new source and runs the whole Glide
   * request again. This used to hand the first layer the ThumbHash only until
   * the layer displayed, then null — so every open reloaded the photograph it
   * had just drawn, and the reload showed as a blackout of two frames between
   * two identical pictures. Logged on a Pixel 5 on 2026-10-19: the tile's rung
   * displayed at +58 ms, started loading again at +80 ms with no placeholder,
   * and displayed again at +110 ms.
   */
  const placeholderLayer = useRef(layers[0] ?? null);
  useEffect(() => {
    if (!uri) {
      setLayers([]);
      return;
    }
    // A stage that mounted with nothing to draw gives the ThumbHash to the first
    // layer that arrives, decided before that layer mounts.
    placeholderLayer.current ??= uri;
    // Appended, never replaced. The layer beneath is the previous photograph,
    // which is a far better thing to have under a decode than a blur.
    //
    // A URI already in the stack is a page going back to a picture it showed
    // earlier, which happens when a resolution is replaced by an older one. The
    // stack drops back to that layer rather than mounting a second `<Image>`
    // under the same key, which React would treat as one element.
    setLayers((current) => {
      const at = current.indexOf(uri);
      if (at === current.length - 1) return current;
      return at >= 0 ? current.slice(0, at + 1) : [...current, uri];
    });
  }, [uri]);

  /**
   * One `source` object per URI, for the lifetime of this stage.
   *
   * A fresh `{ uri }` literal on every render would undo the layering entirely.
   * React reuses a keyed `<Image>` across re-renders — which is the point — and
   * hands it whatever props that render produced, so a new object identity in
   * `source` is `expo-image` being told the source changed for bytes it has
   * already decoded. The layer stack exists precisely to stop that happening,
   * and it re-renders on every `shown` change, so it would have caused the
   * problem it was written to prevent.
   *
   * A ref rather than `useMemo` over `layers`: appending a layer produces a new
   * array, and a memo keyed on it would rebuild the *existing* layers' sources
   * too.
   */
  const sources = useRef(new Map<string, { uri: string }>());
  const sourceFor = useCallback((uri: string) => {
    let source = sources.current.get(uri);
    if (!source) sources.current.set(uri, (source = { uri }));
    return source;
  }, []);

  /**
   * The ThumbHash as one stable object, for the same reason.
   *
   * `expo-image` treats the placeholder as a source of its own, so a fresh
   * literal per render is a second thing being re-pointed under the picture.
   */
  const placeholder = useMemo(
    () => (thumbHash ? { thumbhash: thumbHash } : null),
    [thumbHash],
  );

  /**
   * A layer has rendered: it becomes the visible one, and the stack collapses to
   * it.
   *
   * Both state writes in one handler, so React commits them together — the frame
   * the incoming layer becomes opaque is the frame the layer beneath unmounts,
   * and there is never a frame with two opaque pictures or none.
   *
   * The collapse is guarded on the layer still being the top one. A display
   * callback from a layer that has since been superseded must not throw away the
   * newer layer above it.
   */
  const onDisplayed = useCallback(
    (layer: string) => {
      perf("image:display");
      setShown(layer);
      setLayers((current) => (current[current.length - 1] === layer ? [layer] : current));
      onPainted();
    },
    [onPainted],
  );

  return (
    <View style={styles.viewerStage}>
      <Pressable style={styles.viewerImageArea} onPress={onTap}>
        {layers.length > 0 ? (
          layers.map((layer, index) => (
            <Image
              // **Keyed on its own URI**, which is what makes this a new mount
              // rather than a re-point. See the layer stack above.
              key={layer}
              source={sourceFor(layer)}
              style={[
                styles.viewerImage,
                // Opaque once it has rendered, and the bottom layer is opaque
                // from the start — it is either the first picture of the viewing
                // or the survivor of the last collapse, and in both cases it is
                // what is on screen.
                { opacity: index === 0 || shown === layer ? 1 : 0 },
              ]}
              contentFit="contain"
              // **The first layer only.** Under any later layer is the previous
              // photograph, which is a better placeholder than a blur of it.
              //
              // The floor matters more here than on a tile: this screen shows
              // one picture, and the alternative to a ThumbHash is an empty
              // rectangle the size of the display. Decoded natively by
              // `expo-image` from the base64 string — see `media/thumb-hash.ts`.
              placeholder={layer === placeholderLayer.current ? placeholder : null}
              // Contain, unlike the tile's placeholder. A tile's ThumbHash fills
              // a box of the photograph's own shape, so there is nothing to
              // crop; a full screen is not that shape, and a stretched blur
              // reads as a rendering fault rather than as a picture arriving.
              placeholderContentFit="contain"
              // Memory, unlike the grid's tiles. One picture at a time, and
              // re-decoding a full-size rendition every time somebody swipes
              // back to it is exactly the cost worth paying once.
              cachePolicy="memory-disk"
              // The opposite of the tile's. Whatever is on this screen is the
              // thing somebody is waiting for.
              priority="high"
              onLoadStart={() => perf("image:loadStart")}
              onLoad={(event) =>
                perf(`image:load ${event.source.width}x${event.source.height} cache=${event.cacheType}`)
              }
              // The signal the body's deferred work waits on, and the swap
              // itself. `onDisplay` fires when the view has actually rendered
              // the picture rather than when the bytes finished loading, which
              // is the difference between swapping to a decoded layer and
              // swapping to an empty one.
              onDisplay={() => onDisplayed(layer)}
              // A source that will not decode still settles the stage, and still
              // collapses the stack — otherwise one unreadable rung would leave
              // a transparent layer over the picture beneath it forever.
              onError={() => onDisplayed(layer)}
            />
          ))
        ) : thumbHash ? (
          // No bytes anywhere, and a blurred version of the right photograph is
          // a far better answer than a line of text about storage.
          <Image
            source={null}
            style={styles.viewerImage}
            contentFit="contain"
            placeholder={placeholder}
            placeholderContentFit="contain"
            onDisplay={onPainted}
            onError={onPainted}
          />
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
  return (
    <View style={styles.viewerImageArea}>
      {/* `nativeControls` rather than controls of this app's own: play,
          scrub and the fullscreen button are the platform's, which is what
          makes them behave the way every other video on the device does.
          Fullscreen is enabled by default and is not restated here. */}
      <VideoView player={player} style={styles.viewerImage} nativeControls contentFit="contain" />
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
  return (
    <Pressable style={styles.viewerImageArea} onPress={onStop}>
      <VideoView
        player={player}
        style={styles.viewerImage}
        contentFit="contain"
        nativeControls={false}
      />
    </Pressable>
  );
}
