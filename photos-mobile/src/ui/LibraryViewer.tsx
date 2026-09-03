/**
 * One photo, full screen.
 *
 * Split out of `LibraryGrid` when the grid became virtualized. The two now have
 * genuinely different lifetimes: a row is mounted and unmounted as it scrolls,
 * and the viewer must outlive every one of them — it is opened *from* a tile and
 * has to survive that tile being recycled out from under it while somebody is
 * looking at the picture. Leaving it inside the component that renders rows
 * would have tied it to whichever row happened to open it.
 */

import { useEffect, useState } from "react";
import { AppState, Modal, Pressable, Text, View } from "react-native";
// The only video player this app has. `expo-av` is not an option — the package
// is removed from SDK 54 onward — and React Native ships none of its own.
import { useVideoPlayer, VideoView } from "expo-video";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import type { LibraryItem } from "../library";
import type { OpenMotionPhoto } from "../media/motion-photo-playback";
import { styles } from "./theme";
import { formatBytes } from "./format";

/**
 * One photo, full screen.
 *
 * A `Modal` rather than a navigator: there is one thing to push and one way
 * back, and the day there is a stack worth managing is the day to add one —
 * the same argument `App.tsx` makes about the shell.
 *
 * ## Why the body is a second component
 *
 * `useVideoPlayer` is a hook, so it has to run on every render of whatever
 * component holds it — and this one returns early when nothing is open. Mounting
 * the body only while an item is open is the smaller of the two ways out, and it
 * has a second benefit: the player is constructed when a photo is opened and
 * torn down when it is closed, rather than living for the life of the screen.
 */
export function LibraryViewer({
  item,
  busy,
  pinned,
  onTogglePin,
  onFetch,
  onOpenMotion,
  onClose,
}: {
  item: LibraryItem | null;
  busy: boolean;
  pinned: boolean;
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
        key={item.record.id}
        item={item}
        busy={busy}
        pinned={pinned}
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
  onTogglePin,
  onFetch,
  onOpenMotion,
  onClose,
}: {
  item: LibraryItem;
  busy: boolean;
  pinned: boolean;
  onTogglePin: (item: LibraryItem) => void;
  onFetch: (item: LibraryItem) => Promise<boolean>;
  onOpenMotion: (item: LibraryItem) => Promise<OpenMotionPhoto | null>;
  onClose: () => void;
}) {
  const { record, uri, bytesHere, playbackUri } = item;

  /**
   * The player, or a player with nothing in it for a still.
   *
   * `contentType: "progressive"` is stated rather than left to inference, and
   * the reason is a file with no extension. A blob fetched from the cloud lands
   * at `shared/video/<shard>/<hash>`, and ExoPlayer's default source factory
   * infers the container from the URI before it falls back to sniffing — so a
   * clip that plays perfectly when imported from the camera roll would be the
   * one that fails after arriving by sync.
   *
   * **No autoplay.** The viewer opens on the first frame with the platform's own
   * controls, and a person presses play. A video that starts making noise
   * because a tile was tapped is a surprise, and on a phone the bytes may be a
   * 47 MB original.
   */
  const player = useVideoPlayer(
    playbackUri ? { uri: playbackUri, contentType: "progressive" as const } : null,
    (p) => {
      p.loop = false;
    },
  );

  /**
   * The clip inside this photograph, if it is a Motion Photo.
   *
   * Opened when the viewer opens rather than when the control is tapped, so the
   * control can appear at all: whether a photograph has motion is not knowable
   * without asking, and a button that might do nothing is worse than no button.
   * Released on the way out, and on the way to the background — a scratch file
   * lasts exactly one viewing by design, and a process the OS is about to freeze
   * is not one that will get to release anything later.
   */
  const [motion, setMotion] = useState<OpenMotionPhoto | null>(null);
  const [playingMotion, setPlayingMotion] = useState(false);
  useEffect(() => {
    let released = false;
    let handle: OpenMotionPhoto | null = null;
    void onOpenMotion(item).then((opened) => {
      handle = opened;
      // Opened after the viewer already closed. Hand the file straight back
      // rather than leave one nothing will ever collect but the start-up sweep.
      if (released) opened?.release();
      else setMotion(opened);
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
      background.remove();
      handle?.release();
    };
  }, [item, onOpenMotion]);

  /**
   * The Motion Photo's player, seeked to the frame that is the photograph.
   *
   * `presentationTimestampUs` is where the still sits inside the clip, and
   * starting there is what makes the swap seamless: the first frame the player
   * shows is the one already on screen, and what follows is what happened next.
   * Starting at zero would jump backwards by a second and a half, which reads as
   * a glitch rather than as motion.
   */
  const motionPlayer = useVideoPlayer(
    motion ? { uri: motion.uri, contentType: "progressive" as const } : null,
    (p) => {
      p.loop = true;
      if (motion?.presentationTimestampUs) {
        p.currentTime = motion.presentationTimestampUs / 1_000_000;
      }
    },
  );

  return (
    <SafeAreaView style={styles.viewerSafe}>
      {playbackUri ? (
        // Not inside the dismiss-on-tap `Pressable` the still uses: every tap
        // on a player is aimed at the player's own controls, and closing the
        // viewer on a press of the scrubber would make the controls unusable.
        <View style={styles.viewerImageArea}>
          {/* `nativeControls` rather than controls of this app's own: play,
              scrub and the fullscreen button are the platform's, which is what
              makes them behave the way every other video on the device does.
              Fullscreen is enabled by default and is not restated here. */}
          <VideoView
            player={player}
            style={styles.viewerImage}
            nativeControls
            contentFit="contain"
          />
        </View>
      ) : (
        <Pressable style={styles.viewerImageArea} onPress={onClose}>
          {uri && playingMotion && motion ? (
            // No controls, unlike a video record's player. This is a photograph
            // that moves, not a clip to scrub: the gesture is tap to see it and
            // tap again to stop, and a scrubber over a second-and-a-half loop is
            // furniture nobody wants.
            <VideoView
              player={motionPlayer}
              style={styles.viewerImage}
              contentFit="contain"
              nativeControls={false}
            />
          ) : uri ? (
            <Image source={{ uri }} style={styles.viewerImage} contentFit="contain" />
          ) : bytesHere ? (
            // A record whose bytes are here and which has no still to draw and
            // nothing to play. Not a video — those take the branch above — so
            // this is a type this app cannot display, which is a real state
            // and a different one from missing bytes.
            <Text style={styles.muted}>
              Starkeep holds this record&rsquo;s bytes and has nothing to show for them.
            </Text>
          ) : (
            <Text style={styles.muted}>
              This record&rsquo;s bytes are not on this device.
            </Text>
          )}
        </Pressable>
      )}

      <View style={styles.viewerFooter}>
        <Text style={styles.body}>{record.originalFilename ?? "unnamed"}</Text>
        {/* Offered only when there is genuinely motion in these bytes, which is
            what opening the clip up front buys. The record stays one image
            everywhere else in the app — it sorts, syncs, counts and evicts as a
            single still — and this is the only place its bytes behave
            differently. */}
        {motion ? (
          <Pressable
            onPress={() => {
              const next = !playingMotion;
              setPlayingMotion(next);
              if (next) motionPlayer.play();
              else motionPlayer.pause();
            }}
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
            photo. */}
        {uri || bytesHere ? null : (
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
 * Whether this record is a clip, asked of the record rather than of the URIs.
 *
 * `playbackUri` is null for a video whose bytes this node declined, and such a
 * record is still a video — a tile that dropped the badge for it would report
 * an elided clip as a photograph that will not open.
 */
