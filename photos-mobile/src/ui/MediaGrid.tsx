/**
 * The device's own photos and videos, on screen.
 *
 * The first thing in this app that is neither diagnostics nor a status line —
 * and the first that needs no account, no cloud and no network. Which is why it
 * is at the top of the screen: it is the content, and everything below it is
 * information about the machinery.
 *
 * ## Not a virtualised list, deliberately
 *
 * A fixed, small number of tiles in a wrapping row. `FlatList` inside a
 * `ScrollView` is a nested-virtualisation warning and a scroll-handling mess,
 * and virtualisation buys nothing at this size. The day this shows a whole
 * 60k-item library is the day it becomes its own screen with its own list —
 * item 15a — and that is a different component, not a prop on this one.
 *
 * ## What these tiles are not
 *
 * They are the device's files, read straight from the media store. Nothing here
 * has been imported into the node, hashed, given a record or made syncable —
 * that is the import loop, and it is a later item. The caption says so, because
 * a grid that looks like a library invites the assumption that the library
 * holds it.
 */

import { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
// Glide-backed, for the same reason `LibraryGrid` uses it: RN's own `<Image>`
// cannot decode the AVIF this app produces. A camera-roll asset is a JPEG and
// would render either way, but two grids drawing the same pictures through two
// different pipelines is a difference nobody would think to suspect.
import { Image } from "expo-image";
import {
  describeAccess,
  listRecentMedia,
  type DeviceMediaItem,
  type DeviceMediaModule,
  type MediaAccess,
} from "../media/device-library";
import { IMPORTABLE_MEDIA_TYPES } from "../media/import";
import { styles } from "./theme";
import { VideoBadge } from "./VideoBadge";

/** How many tiles the shell shows. Not a page size — a deliberate ceiling. */
export const RECENT_LIMIT = 60;

interface Props {
  readonly media: DeviceMediaModule;
  /**
   * Whether this node already holds the asset behind a tile.
   *
   * Supplied rather than looked up here, because the answer lives in the node's
   * alias table and this component deliberately knows nothing about the node —
   * it reads the device's media store and nothing else.
   *
   * Optional, and absent means "do not say". A grid that marked every tile as
   * missing because nobody told it otherwise would be worse than one that marks
   * nothing: this is the control somebody reaches for when the two grids
   * disagree, so it has to be right or silent.
   */
  readonly isImported?: (assetId: string) => boolean;
}

type State =
  | { readonly status: "checking" }
  | { readonly status: "no-access"; readonly access: MediaAccess }
  | { readonly status: "ready"; readonly access: MediaAccess; readonly items: DeviceMediaItem[] }
  | { readonly status: "failed"; readonly error: string };

export function MediaGrid({ media, isImported }: Props) {
  const [state, setState] = useState<State>({ status: "checking" });
  /** The asset whose details are open, so a filename can be read off a tile. */
  const [inspecting, setInspecting] = useState<DeviceMediaItem | null>(null);

  const load = useCallback(
    async (permission: Awaited<ReturnType<DeviceMediaModule["getPermissions"]>>) => {
      const access = describeAccess(permission);
      if (access === "denied" || access === "blocked") {
        setState({ status: "no-access", access });
        return;
      }
      try {
        setState({
          status: "ready",
          access,
          // **Filtered to the kinds import will consider, not left to the
          // media store's default.** `exeForMetadata()` queries
          // `MediaStore.Files`, so an unfiltered window contains whatever the
          // store has indexed — other applications' files under their own
          // `Android/media/` directories, rows with `media_type = 0` and a null
          // MIME type, entries in a messaging app's trash. Import refuses all
          // of it, so showing it here made this grid disagree with the library
          // by rows that could never become records, which reads as data
          // missing rather than as data excluded.
          //
          // The same constant import uses, so the two cannot drift apart into
          // separate answers to "what is on this phone".
          items: await listRecentMedia(media, {
            limit: RECENT_LIMIT,
            mediaTypes: IMPORTABLE_MEDIA_TYPES,
          }),
        });
      } catch (err) {
        setState({ status: "failed", error: String(err) });
      }
    },
    [media],
  );

  // Checks the permission it already has; never prompts on its own. An app that
  // throws a system dialog at you before you have done anything has asked for
  // something before saying what for.
  useEffect(() => {
    let cancelled = false;
    void media
      .getPermissions()
      .then((permission) => {
        if (!cancelled) void load(permission);
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "failed", error: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [media, load]);

  const ask = useCallback(() => {
    void media
      .requestPermissions()
      .then(load)
      .catch((err: unknown) => setState({ status: "failed", error: String(err) }));
  }, [media, load]);

  if (state.status === "checking") {
    return <Text style={styles.muted}>Looking for photos on this device…</Text>;
  }

  if (state.status === "failed") {
    return <Text style={styles.error}>{state.error}</Text>;
  }

  if (state.status === "no-access") {
    return (
      <View style={{ gap: 10 }}>
        <Text style={styles.muted}>
          {state.access === "blocked"
            ? "Android is not letting this app ask for photo access again. It can be granted in Settings → Apps → Starkeep → Permissions."
            : "Starkeep can show the photos and videos already on this device. Nothing is uploaded — this is your device reading its own media store."}
        </Text>
        {state.access === "denied" ? (
          <Pressable style={styles.button} onPress={ask}>
            <Text style={styles.buttonLabel}>Allow access to photos</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  if (state.items.length === 0) {
    return (
      <Text style={styles.muted}>
        {state.access === "limited"
          ? "No photos among the ones shared with this app."
          : "No photos or videos found on this device."}
      </Text>
    );
  }

  const missing = isImported
    ? state.items.filter((item) => !isImported(item.id)).length
    : null;

  return (
    <View style={{ gap: 8 }}>
      <View style={styles.grid}>
        {state.items.map((item) => (
          <Tile
            key={item.id}
            item={item}
            inNode={isImported ? isImported(item.id) : null}
            onPress={() => setInspecting(item)}
          />
        ))}
      </View>
      {/* Says what the two grids disagree about, which is the question anybody
          opens this section to answer. A count is enough to know whether to look
          further; the tiles say which ones. */}
      <Text style={styles.muted}>
        The {state.items.length} most recent
        {state.access === "limited" ? " of the items shared with this app" : " on this device"}, read
        from the device&rsquo;s media store.
        {missing === null
          ? " Nothing here says whether the node holds it."
          : missing === 0
            ? " Every one of them is in this node's library."
            : ` ${missing} of them ${missing === 1 ? "is" : "are"} not in this node's library — tap a dimmed tile to see which.`}
      </Text>

      <AssetDetail
        item={inspecting}
        inNode={inspecting && isImported ? isImported(inspecting.id) : null}
        onClose={() => setInspecting(null)}
      />
    </View>
  );
}

function Tile({
  item,
  inNode,
  onPress,
}: {
  readonly item: DeviceMediaItem;
  /** Null when nobody can say — see {@link Props.isImported}. */
  readonly inNode: boolean | null;
  readonly onPress: () => void;
}) {
  return (
    <Pressable style={styles.tile} onPress={onPress}>
      <Image
        source={{ uri: item.uri }}
        style={[styles.tileImage, inNode === false ? styles.tileNotImported : null]}
        contentFit="cover"
        recyclingKey={item.id}
      />
      {/* Videos are worth marking: a still frame with no marker reads as a photo
          that will not play when tapped. The same component the library grid
          uses, in the same corner — the two grids draw the same files, and
          marking them differently reads as two apps. */}
      {item.kind === "video" ? <VideoBadge durationMs={item.durationMs} /> : null}
      {/* Dimming alone would read as a loading state, so the tile says which
          state it is in. Only for the absent case: marking all of a working
          library would be noise on every tile to report nothing. */}
      {inNode === false ? <Text style={styles.tileMissingMark}>not in node</Text> : null}
    </Pressable>
  );
}

/**
 * What one asset is, for somebody comparing the two grids by hand.
 *
 * The filename is the whole point. When the device grid and the library grid
 * disagree, the only way to say *which* photograph is at issue is to name it,
 * and until now nothing on this screen ever showed a filename.
 */
function AssetDetail({
  item,
  inNode,
  onClose,
}: {
  readonly item: DeviceMediaItem | null;
  readonly inNode: boolean | null;
  readonly onClose: () => void;
}) {
  if (!item) return null;
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} transparent={false}>
      <SafeAreaView style={styles.viewerSafe}>
        <Pressable style={styles.viewerImageArea} onPress={onClose}>
          <Image source={{ uri: item.uri }} style={styles.viewerImage} contentFit="contain" />
        </Pressable>
        <View style={styles.viewerFooter}>
          <Text style={styles.body}>{item.filename ?? "unnamed"}</Text>
          <Text style={styles.muted}>
            {item.kind}
            {item.width && item.height ? ` · ${item.width}×${item.height}` : ""}
            {item.createdAt ? ` · taken ${new Date(item.createdAt).toLocaleString()}` : " · no capture time"}
          </Text>
          <Text style={styles.muted}>
            {item.modifiedAt
              ? `changed here ${new Date(item.modifiedAt).toLocaleString()}`
              : "the media store recorded no modification time for this asset"}
          </Text>
          {/* The asset id, because it is what every diagnostic on the other side
              keys on — the alias table, the import cursor, and an `adb` query
              against the media store all name an asset this way. */}
          <Text style={styles.mono}>{item.id}</Text>
          <Text style={inNode === false ? styles.error : styles.muted}>
            {inNode === null
              ? "Whether this node holds it is not known here."
              : inNode
                ? "This node holds it."
                : "This node does not hold it."}
          </Text>
          <Pressable onPress={onClose} style={{ paddingVertical: 8 }}>
            <Text style={styles.linkLabel}>Close</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  );
}
