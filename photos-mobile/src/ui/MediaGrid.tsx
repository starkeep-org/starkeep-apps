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
import { Image, Pressable, Text, View } from "react-native";
import {
  describeAccess,
  formatDuration,
  listRecentMedia,
  type DeviceMediaItem,
  type DeviceMediaModule,
  type MediaAccess,
} from "../media/device-library";
import { styles } from "./theme";

/** How many tiles the shell shows. Not a page size — a deliberate ceiling. */
export const RECENT_LIMIT = 60;

interface Props {
  readonly media: DeviceMediaModule;
}

type State =
  | { readonly status: "checking" }
  | { readonly status: "no-access"; readonly access: MediaAccess }
  | { readonly status: "ready"; readonly access: MediaAccess; readonly items: DeviceMediaItem[] }
  | { readonly status: "failed"; readonly error: string };

export function MediaGrid({ media }: Props) {
  const [state, setState] = useState<State>({ status: "checking" });

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
          items: await listRecentMedia(media, { limit: RECENT_LIMIT }),
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

  return (
    <View style={{ gap: 8 }}>
      <View style={styles.grid}>
        {state.items.map((item) => (
          <Tile key={item.id} item={item} />
        ))}
      </View>
      <Text style={styles.muted}>
        The {state.items.length} most recent
        {state.access === "limited" ? " of the items shared with this app" : " on this device"}. Read
        from the device&rsquo;s media store — none of it has been imported into the node yet.
      </Text>
    </View>
  );
}

function Tile({ item }: { item: DeviceMediaItem }) {
  return (
    <View style={styles.tile}>
      <Image source={{ uri: item.uri }} style={styles.tileImage} resizeMode="cover" />
      {/* Videos are worth marking: a still frame with no marker reads as a photo
          that will not play when tapped. */}
      {item.kind === "video" ? (
        <Text style={styles.tileBadge}>{formatDuration(item.durationMs)}</Text>
      ) : null}
    </View>
  );
}
