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
  InteractionManager,
  Modal,
  PanResponder,
  Pressable,
  Text,
  View,
} from "react-native";
// The only video player this app has. `expo-av` is not an option — the package
// is removed from SDK 54 onward — and React Native ships none of its own.
import { useVideoPlayer, VideoView } from "expo-video";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import type { LibraryItem } from "../library";
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
  if (!item) return null;
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} transparent={false}>
      <ViewerBody
        // Keyed on the record, so opening a second photograph builds a fresh
        // body rather than reusing one whose motion handle belongs to the first.
        // Stepping to the next photograph goes through the same key, which is
        // what releases the previous one's scratch clip.
        key={item.record.id}
        item={item}
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
    </Modal>
  );
}

function ViewerBody({
  item,
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
   * display callback itself. Waiting on the *picture* rather than on the modal
   * is deliberate and was measured: `Modal`'s fade is animated natively and
   * registers no interaction handle, so `runAfterInteractions` alone fired 36 ms
   * after mount and the scan landed in front of the photograph exactly as
   * before.
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
    <SafeAreaView style={styles.viewerSafe}>
      {playbackUri ? (
        <VideoStage uri={playbackUri} />
      ) : playingMotion && motion && uri ? (
        <MotionStage motion={motion} onStop={stopMotion} />
      ) : (
        <StillStage
          uri={uri}
          thumbHash={thumbHash}
          bytesHere={bytesHere}
          panHandlers={swipe.panHandlers}
          onPainted={onPainted}
          onClose={onClose}
        />
      )}

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
    </SafeAreaView>
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
  panHandlers,
  onPainted,
  onClose,
}: {
  uri: string | null;
  thumbHash: string | null;
  bytesHere: boolean;
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
  return (
    <View style={styles.viewerStage} {...panHandlers}>
      <Pressable style={styles.viewerImageArea} onPress={onClose}>
        {uri || thumbHash ? (
          <Image
            // Null rather than absent when there is no source, so the
            // placeholder below is what gets drawn. A record with a ThumbHash
            // and no resolvable bytes is not nothing to look at — it is a
            // blurred version of the right photograph, which is a far better
            // answer than a line of text about storage.
            source={uri ? { uri } : null}
            style={styles.viewerImage}
            contentFit="contain"
            // The same floor the tile has, and it matters more here: this
            // screen is showing one picture, and the alternative to a
            // ThumbHash is an empty rectangle the size of the display. Decoded
            // natively by `expo-image` from the base64 string — see
            // `media/thumb-hash.ts`.
            placeholder={thumbHash ? { thumbhash: thumbHash } : null}
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
            onLoad={() => perf("image:load")}
            // The signal the body's deferred work waits on. `onDisplay` fires
            // for the ThumbHash too, which is the right moment either way:
            // something the size of the screen is on it, and what follows is an
            // improvement rather than an arrival.
            onDisplay={() => {
              perf("image:display");
              onPainted();
            }}
            // A source that will not decode still settles the stage. Otherwise
            // one unreadable file would leave the motion control missing for a
            // photograph whose neighbours all offer it.
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
