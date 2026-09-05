/**
 * One photo, full screen.
 *
 * Split out of `LibraryGrid` when the grid became virtualized. The two now have
 * genuinely different lifetimes: a row is mounted and unmounted as it scrolls,
 * and the viewer must outlive every one of them — it is opened *from* a tile and
 * has to survive that tile being recycled out from under it while somebody is
 * looking at the picture. Leaving it inside the component that renders rows
 * would have tied it to whichever row happened to open it.
 *
 * ## Why the stage is three components rather than one body with three branches
 *
 * `useVideoPlayer` is a hook, so a component that holds one pays for it on every
 * render — and constructing a player is not free. A single body that called it
 * twice, once for a video record and once for a Motion Photo's clip, built two
 * `ExoPlayer` instances every time anybody opened anything. Measured on a Pixel 5
 * against an ordinary still photograph with no video anywhere in it, the two
 * `ExoPlayerImpl.Init` lines landed 260 ms and 335 ms after the tap, and the tap
 * cost about 700 ms end to end.
 *
 * So the branch moved up. A still mounts {@link StillStage}, which holds no
 * player at all; a video mounts {@link VideoStage}, which holds one; and the
 * clip inside a Motion Photo gets {@link MotionStage}, which is mounted only
 * once somebody presses play — a control that might do nothing is worse than no
 * control, but a player nobody asked for is worse than both.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  BackHandler,
  InteractionManager,
  PanResponder,
  PixelRatio,
  Pressable,
  Text,
  View,
} from "react-native";
// The only video player this app has. `expo-av` is not an option — the package
// is removed from SDK 54 onward — and React Native ships none of its own.
import { useVideoPlayer, VideoView } from "expo-video";
import { Image, type ImageLoadEventData } from "expo-image";
import type { LibraryItem } from "../library";
import type { Dimensions as Box } from "../photos/render-target";
import type { OpenMotionPhoto } from "../media/motion-photo-playback";
import { styles } from "./theme";
import { formatBytes } from "./format";
import { perf } from "./perf";

/**
 * How far a finger has to travel sideways before it counts as "next photo".
 *
 * In layout points, and deliberately larger than the slop that distinguishes a
 * tap from a drag: a tap anywhere on a still dismisses the viewer, so a gesture
 * that is *nearly* a tap must not navigate. The dominance test beside it is what
 * keeps a diagonal from counting.
 */
const SWIPE_DISTANCE = 60;

/** Which way somebody swiped, as a step through the library. */
export type ViewerStep = -1 | 1;

export function LibraryViewer({
  item,
  stage,
  busy,
  pinned,
  hasPrevious,
  hasNext,
  onStep,
  onTogglePin,
  onFetch,
  onOpenMotion,
  onClose,
}: {
  item: LibraryItem | null;
  /** The box the photograph gets, in layout points. See `viewerStageBox`. */
  stage: Box;
  busy: boolean;
  pinned: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  onStep: (step: ViewerStep) => void;
  onTogglePin: (item: LibraryItem) => void;
  onFetch: (item: LibraryItem) => Promise<boolean>;
  onOpenMotion: (item: LibraryItem) => Promise<OpenMotionPhoto | null>;
  onClose: () => void;
}) {
  /**
   * The hardware back button, which is the one thing `Modal` was doing for free.
   *
   * Registered whenever a record is open and removed when it is not, so the
   * button falls through to whatever else claims it — and to the OS, which exits
   * the app — while the grid is what is on screen. Returning true is what tells
   * Android the press was handled.
   *
   * Above the early return rather than inside the body, because hooks may not be
   * conditional and the viewer is mounted with `item === null` for most of the
   * app's life.
   */
  const open = item !== null;
  useEffect(() => {
    if (!open) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [open, onClose]);

  if (!item) return null;
  return (
    // **A screen, not a dialog window.** `Modal` builds a second view hierarchy
    // and animates it in front of a screen this app already owns, which costs a
    // window animation and a second inset measurement for a surface that is
    // simply the next thing to look at. This is a full-bleed overlay in
    // `HomeScreen`'s own tree instead — no navigator needed, and the grid stays
    // mounted underneath, which is what keeps its scroll position and stops
    // every tile re-decoding on the way back.
    //
    // The day this app has a third destination, the overlay becomes a route with
    // no change to anything below here.
    <View style={styles.viewerOverlay}>
      <ViewerBody
        // Keyed on the record, so opening a second photograph builds a fresh
        // body rather than reusing one whose motion handle belongs to the first.
        // Stepping to the next photograph goes through the same key, which is
        // what releases the previous one's scratch clip.
        key={item.record.id}
        item={item}
        stage={stage}
        busy={busy}
        pinned={pinned}
        hasPrevious={hasPrevious}
        hasNext={hasNext}
        onStep={onStep}
        onTogglePin={onTogglePin}
        onFetch={onFetch}
        onOpenMotion={onOpenMotion}
        onClose={onClose}
      />
    </View>
  );
}

function ViewerBody({
  item,
  stage,
  busy,
  pinned,
  hasPrevious,
  hasNext,
  onStep,
  onTogglePin,
  onFetch,
  onOpenMotion,
  onClose,
}: {
  item: LibraryItem;
  stage: Box;
  busy: boolean;
  pinned: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  onStep: (step: ViewerStep) => void;
  onTogglePin: (item: LibraryItem) => void;
  onFetch: (item: LibraryItem) => Promise<boolean>;
  onOpenMotion: (item: LibraryItem) => Promise<OpenMotionPhoto | null>;
  onClose: () => void;
}) {
  const { record, uri, bytesHere, playbackUri, thumbHash } = item;
  perf("body:render");
  useEffect(() => {
    perf("body:mounted");
    return () => perf("body:unmount");
  }, []);

  /**
   * The clip inside this photograph, if it is a Motion Photo.
   *
   * Opened when the viewer opens rather than when the control is tapped, so the
   * control can appear at all: whether a photograph has motion is not knowable
   * without asking, and a button that might do nothing is worse than no button.
   * Released on the way out, and on the way to the background — a scratch file
   * lasts exactly one viewing by design, and a process the OS is about to freeze
   * is not one that will get to release anything later.
   *
   * Not asked at all of a video record. `openMotionPhoto` would answer null for
   * one anyway — the format is Google's and it is defined over JPEG — and
   * skipping the call keeps a clip's open free of a question about stills.
   *
   * ## Asked after the screen has settled, not while it is arriving
   *
   * A record the motion index has already covered answers in about 3 ms. One it
   * has not costs a whole-file read and a scan for XMP — 900 ms on a Pixel 5 for
   * a 1.6 MB JPEG — on the JavaScript thread, and it used to run before anything
   * was on screen. It was the largest single item in the 1.2 s between tapping a
   * tile and seeing the photograph, and it delayed the viewer's own resolve
   * behind it, because both wait on the same thread.
   *
   * So the ask waits for the stage to say it has something on screen, and
   * `runAfterInteractions` then puts it in an idle frame rather than inside the
   * display callback itself. Waiting on the *picture* rather than on the mount
   * is deliberate and was measured: `runAfterInteractions` alone fired 36 ms
   * after mount and the scan landed in front of the photograph exactly as
   * before. That was against a `Modal`, whose fade is animated natively and
   * registers no interaction handle; the overlay that replaced it has no
   * animation to register one either, so the reasoning carries over unchanged.
   *
   * The scan costs the same whenever it runs, and it writes its answer down, so
   * a record pays it once ever rather than once per opening.
   */
  const [motion, setMotion] = useState<OpenMotionPhoto | null>(null);
  const [playingMotion, setPlayingMotion] = useState(false);
  /**
   * Whether the stage has drawn what it has, so background work may start.
   *
   * Reset by remounting rather than by a setter: {@link LibraryViewer} keys the
   * body on the record, so stepping to the next photograph builds a fresh body
   * and a fresh `false`.
   */
  const [painted, setPainted] = useState(false);
  const onPainted = useCallback(() => setPainted(true), []);
  useEffect(() => {
    if (playbackUri || !painted) return;
    let released = false;
    let handle: OpenMotionPhoto | null = null;
    const deferred = InteractionManager.runAfterInteractions(() => {
      // Cancelled and already-run race on a fast close, and `cancel()` does not
      // unschedule a task that has begun. The flag is what makes the late one
      // harmless.
      if (released) return;
      perf("motion:ask");
      void onOpenMotion(item).then((opened) => {
        perf(`motion:answered found=${opened !== null}`);
        handle = opened;
        // Opened after the viewer already closed. Hand the file straight back
        // rather than leave one nothing will ever collect but the start-up sweep.
        if (released) opened?.release();
        else setMotion(opened);
      });
    });
    const background = AppState.addEventListener("change", (state) => {
      if (state === "active") return;
      setPlayingMotion(false);
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
    };
  }, [item, onOpenMotion, playbackUri, painted]);

  /**
   * Sideways to move through the library, and nothing else claimed.
   *
   * `onMoveShouldSetPanResponder` rather than `onStartShouldSet`, so a touch is
   * only taken away from the children once it has travelled — a tap on a still
   * still dismisses, and a press on a control still presses. The dominance test
   * is what separates this from the vertical drag somebody makes reaching for
   * the footer.
   *
   * Only the still stage wires this up. A video's own scrubber is a horizontal
   * drag on a native view, and a viewer that stole it to change photographs
   * would make the platform's controls unusable — which is the argument the
   * video branch already makes about not dismissing on tap.
   */
  const stepRef = useRef(onStep);
  stepRef.current = onStep;
  const swipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > SWIPE_DISTANCE &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
        onPanResponderRelease: (_event, gesture) => {
          if (Math.abs(gesture.dx) < SWIPE_DISTANCE) return;
          // Dragging the picture to the left brings the next one in from the
          // right, which is the direction every other gallery on the device
          // moves.
          stepRef.current(gesture.dx < 0 ? 1 : -1);
        },
      }),
    [],
  );

  const stopMotion = useCallback(() => setPlayingMotion(false), []);

  return (
    <View style={styles.viewerSafe}>
      {/* **An explicit height, not `flex: 1`.** The stage is computed from the
          window, the system insets and the footer's stated height, and the
          footer below is given exactly what the same arithmetic reserved. So
          nothing under the photograph can change the box it is drawn into —
          which matters because `expo-image` reissues its whole load whenever
          the view it draws into changes size, and the motion control is a
          control that arrives a second after the picture. */}
      <View style={{ width: stage.width, height: stage.height }}>
        {playbackUri ? (
          <VideoStage uri={playbackUri} />
        ) : playingMotion && motion && uri ? (
          <MotionStage motion={motion} onStop={stopMotion} />
        ) : (
          <StillStage
            uri={uri}
            thumbHash={thumbHash}
            bytesHere={bytesHere}
            fromRendition={item.paintedRendition !== null}
            stage={stage}
            panHandlers={swipe.panHandlers}
            onPainted={onPainted}
            onClose={onClose}
          />
        )}
      </View>

      {/* Given the height the stage arithmetic reserved for it, so a control
          that is absent leaves its space empty rather than collapsing it and
          resizing the picture above. See `VIEWER_FOOTER_HEIGHT`. */}
      <View style={styles.viewerFooter}>
        <Text style={styles.body}>{record.originalFilename ?? "unnamed"}</Text>
        {/* Where this photograph sits, and the only thing on screen that says a
            swipe will do anything. Shown rather than left to be discovered,
            because a gesture with no affordance is a gesture nobody finds. */}
        {hasPrevious || hasNext ? (
          <Text style={styles.muted}>
            {hasPrevious ? "‹ " : ""}Swipe to move through the library{hasNext ? " ›" : ""}
          </Text>
        ) : null}
        {/* Offered only when there is genuinely motion in these bytes, which is
            what opening the clip up front buys. The record stays one image
            everywhere else in the app — it sorts, syncs, counts and evicts as a
            single still — and this is the only place its bytes behave
            differently. */}
        {motion ? (
          <Pressable
            onPress={() => setPlayingMotion((playing) => !playing)}
            style={{ paddingVertical: 8 }}
          >
            <Text style={styles.linkLabel}>
              {playingMotion ? "◉ Motion — tap to stop" : "◎ Play motion"}
            </Text>
          </Pressable>
        ) : null}
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
            photo.

            Offered on `bytesHere` alone now, where it used to also check `uri`.
            The two stopped agreeing the moment a rendition could stand in for an
            absent original: such a record paints a picture and still does not
            have its own bytes, and hiding the control for it would have hidden
            it in exactly the case it was written for. */}
        {bytesHere ? null : (
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
        {/* A pin is this device's own preference and travels with nothing —
            deliberately not a label, because a pin shared as a label would let
            one device's choice silently rewrite every other device's cache
            policy. It beats every budget and recency rule, and it still counts
            against the class's budget, so pinning a lot makes the overage
            visible rather than swallowing it. */}
        <Pressable onPress={() => onTogglePin(item)} style={{ paddingVertical: 8 }}>
          <Text style={styles.linkLabel}>
            {pinned ? "★ Kept on this device — tap to release" : "☆ Keep on this device"}
          </Text>
        </Pressable>
        {pinned ? (
          <Text style={styles.muted}>
            This one stays whatever the storage budget says, and is never chosen when space is
            reclaimed.
          </Text>
        ) : null}
        <Pressable onPress={onClose} style={{ paddingVertical: 8 }}>
          <Text style={styles.linkLabel}>Close</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * A photograph, and the swipe that moves off it.
 *
 * Holds no player, which is the whole reason it is a component: this is what
 * most opens mount, and a still that constructs an `ExoPlayer` on the way in is
 * paying a quarter of a second for a video it does not have.
 *
 * **The swipe is on a wrapper, not on the `Pressable`.** Spreading
 * `panHandlers` onto the `Pressable` looked right and did nothing: `Pressable`
 * renders `<View {...restProps} {...pressabilityHandlers}>`, so its own
 * responder handlers land on the same node *after* the pan handlers and
 * overwrite every one of them. Worse, `Pressability` claims the responder on
 * touch start, and the responder system never asks a node that already holds
 * the responder whether it would like to set it — so `onMoveShouldSetPanResponder`
 * was unreachable twice over.
 *
 * A parent is asked. With a responder already held, the negotiation runs from
 * the common ancestor and skips the responder itself, which is exactly this
 * wrapper's position; `Pressability` answers a termination request with yes, so
 * a finger that travels far enough sideways moves from the tap to the swipe
 * mid-gesture, and the tap it stole is cancelled rather than fired.
 */
function StillStage({
  uri,
  thumbHash,
  bytesHere,
  fromRendition,
  stage,
  panHandlers,
  onPainted,
  onClose,
}: {
  uri: string | null;
  thumbHash: string | null;
  bytesHere: boolean;
  /** Whether these bytes are a rung or the record's own file. See the readout. */
  fromRendition: boolean;
  /** The box this stage was given, in layout points. Fixed for the viewing. */
  stage: Box;
  panHandlers: ReturnType<typeof PanResponder.create>["panHandlers"];
  /**
   * Called once this stage has drawn what it has, which is what releases the
   * body's background work. A stage with nothing to draw reports immediately —
   * there is no picture coming, so nothing is being waited for.
   */
  onPainted: () => void;
  onClose: () => void;
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
   * One open paints up to three times — the tile's rung, the rung the viewer's
   * own resolve finds, and whatever a fetch or an encode brings down — and the
   * old shape pointed one `<Image>` at each in turn. Re-pointing makes
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
  useEffect(() => {
    if (!uri) {
      setLayers([]);
      return;
    }
    // Appended, never replaced. The layer beneath is the previous photograph,
    // which is a far better thing to have under a decode than a blur.
    setLayers((current) => (current[current.length - 1] === uri ? current : [...current, uri]));
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

  /** What the last decode actually produced, and where it came from. */
  const [drawn, setDrawn] = useState<DrawnImage | null>(null);
  /**
   * How many times this stage has replaced the picture since it mounted.
   *
   * One open paints up to three times — the tile's rung, the rung the viewer's
   * own resolve finds, and whatever a fetch or an encode brings down — and each
   * one is a decode somebody can see happen. Counting them on screen is what
   * makes that visible without a logcat.
   *
   * A resize used to count too, because `expo-image` reissues the load when the
   * view it draws into changes size, and the footer grew when the motion control
   * arrived. The stage is a stated box now, so that source of paints is gone and
   * a count above the rungs actually fetched is a real finding.
   */
  const [paints, setPaints] = useState(0);
  const onLoad = useCallback((event: ImageLoadEventData) => {
    perf(
      `image:load ${event.source.width}x${event.source.height} cache=${event.cacheType}`,
    );
    setDrawn({
      width: event.source.width,
      height: event.source.height,
      cacheType: event.cacheType,
    });
    setPaints((count) => count + 1);
  }, []);

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
    <View style={styles.viewerStage} {...panHandlers}>
      <Pressable style={styles.viewerImageArea} onPress={onClose}>
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
              placeholder={index === 0 && shown === null ? placeholder : null}
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
              onLoad={onLoad}
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
      <RenderedSize
        stage={stage}
        drawn={drawn}
        paints={paints}
        fromRendition={fromRendition}
        layers={layers.length}
      />
    </View>
  );
}

/** What one decode produced, as `expo-image` reports it. */
interface DrawnImage {
  /** The decoded drawable's own pixels — after Glide's downsample, not the file's. */
  readonly width: number;
  readonly height: number;
  readonly cacheType: "none" | "disk" | "memory";
}

/**
 * How many pixels are actually on the screen, over the picture they describe.
 *
 * ## Why the number is worth showing
 *
 * The viewer paints whichever rung is resident, and which rung that is depends
 * on what the tile resolved, what the ladder's boundaries are, and what a fetch
 * has managed to bring down since. None of that is visible in the photograph: a
 * 640-pixel rung across a 1080-pixel screen looks like a soft photograph, which
 * is indistinguishable from a soft photograph. So the counts go on screen.
 *
 * Three numbers, and each answers a different question. **Decoded** is what
 * `expo-image` handed the view — the drawable's own pixels, after Glide's
 * downsample, so it is the bitmap being sampled rather than the file's nominal
 * size. **Stage** is the box it is drawn into, in device pixels. **Scale** is
 * the ratio of the two along the binding edge: above 1 the picture is being
 * stretched, which is the state that costs nothing to fix and everything to
 * miss.
 *
 * The stage is now the stated box rather than a measurement of one, and that is
 * what makes the scale worth reading. While the request was measured against a
 * guessed chrome allowance and the layout against whatever the footer rendered
 * as, this readout was the only way to see the two disagree; now they are the
 * same arithmetic, and a scale far from 1 means the *ladder* chose wrong rather
 * than that the geometry did.
 *
 * `paints` and `layers` are the fourth and fifth, and belong to a different
 * question — see {@link StillStage}. A stage that settles at one layer has
 * finished swapping; one that stays at two has a rung that never displayed.
 *
 * An overlay rather than a line in the footer, deliberately: a readout down
 * there would take room the footer reserves for controls.
 */
function RenderedSize({
  stage,
  drawn,
  paints,
  fromRendition,
  layers,
}: {
  stage: Box;
  drawn: DrawnImage | null;
  paints: number;
  fromRendition: boolean;
  /** How many pictures are mounted. Above one means a swap is in flight. */
  layers: number;
}) {
  if (!drawn) return null;
  const density = PixelRatio.get();
  const stagePx = { width: stage.width * density, height: stage.height * density };
  // `contain`, matching what the image paints with: the picture meets the stage
  // on one edge and falls short on the other, and the edge it meets is the one
  // the scale factor is about.
  const scale = Math.min(stagePx.width / drawn.width, stagePx.height / drawn.height);
  const shown = { width: drawn.width * scale, height: drawn.height * scale };
  return (
    <View style={styles.renderedSize} pointerEvents="none">
      <Text style={styles.renderedSizeText}>
        {Math.round(drawn.width)}×{Math.round(drawn.height)} decoded ·{" "}
        {fromRendition ? "rendition" : "original"} · {drawn.cacheType}
      </Text>
      <Text style={styles.renderedSizeText}>
        drawn at {Math.round(shown.width)}×{Math.round(shown.height)} px in a{" "}
        {Math.round(stagePx.width)}×{Math.round(stagePx.height)} px stage
      </Text>
      <Text style={styles.renderedSizeText}>
        {scale >= 1 ? `${scale.toFixed(2)}× upscaled` : `${(1 / scale).toFixed(2)}× spare`} ·{" "}
        {Math.round(stage.width)}×{Math.round(stage.height)} dp @{density}× · paint {paints} ·{" "}
        {layers} layer{layers === 1 ? "" : "s"}
      </Text>
    </View>
  );
}

/**
 * A video record, with the platform's own controls.
 *
 * Not inside a dismiss-on-tap `Pressable` and not inside the swipe, for the same
 * reason: every touch on a player is aimed at the player, and closing the viewer
 * on a press of the scrubber — or stepping to the next photograph on a drag of
 * it — would make the controls unusable.
 *
 * **No autoplay.** The viewer opens on the first frame and a person presses
 * play. A video that starts making noise because a tile was tapped is a
 * surprise, and on a phone the bytes may be a 47 MB original.
 */
function VideoStage({ uri }: { uri: string }) {
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
  });
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
