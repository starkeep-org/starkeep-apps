/**
 * The app. Not a screen you reach by signing in — the one you land on.
 *
 * Everything here works with no session and no network. Signing in is offered
 * from Settings rather than demanded, because a sign-in buys sync and nothing
 * else. A signed-out device is a whole Starkeep node; it is simply the only one
 * that knows what it holds.
 *
 * ## The first-run screen
 *
 * A fresh library asks to sign in before its first import, because importing
 * before the first pull writes over the records other devices made. The
 * screen offers "Import without signing in" too, so a phone that never syncs
 * still works, and a dialog says what that risks. See `media/import-gate.ts`.
 *
 * ## What is on the screen
 *
 * The photographs, under an app bar with a menu, as in the web app. Settings
 * and the viewer open over the grid rather than in place of it, so the grid
 * keeps its scroll position and its decoded tiles underneath them. Landscape
 * hides the app bar and the system bars, and the grid fills the screen.
 *
 * The work that keeps the library current — import, sync, derivation, the
 * background window — runs in `useForegroundWork`, whatever is on screen.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
// Glide-backed, like the grid. Imported here only for `clearMemoryCache`, so
// the screen can drop the decoded bitmaps when the app leaves the foreground.
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  libraryRowKey,
  libraryRows,
  LibraryRow,
  useLibraryViewer,
  type LibraryGridRow,
} from "./LibraryGrid";
import type { LibraryItem } from "../library";
import { colors, GRID_GAP, libraryColumns, styles } from "./theme";
import { onSessionRejected } from "../auth/session";
import { useLibrary, useNode, useStorage } from "./use-library";
import { useForegroundWork } from "./use-foreground-work";
import { AppBar } from "./AppBar";
import { SettingsScreen } from "./SettingsScreen";
import { useIsLandscape, useSystemBarsHidden } from "./orientation";

interface Props {
  /** Open the sign-in screen. */
  readonly onConnect: () => void;
}

export function HomeScreen({ onConnect }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The hook rather than `Dimensions.get`, because this value has to re-render
  // the screen: the tiles are sized against it, and a rotation that did not
  // re-size them would leave every row measured for the other width.
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const landscape = useIsLandscape();
  useSystemBarsHidden(landscape);
  const { state: node, reopen } = useNode();

  /**
   * Why the pool ended this phone's sign-in, when it did: an admin signed the
   * person out everywhere or disabled the account, or the session expired.
   * Settings says so, because otherwise sync would stop without a reason.
   */
  const [sessionEnded, setSessionEnded] = useState<string | null>(null);
  // The session is already cleared when the pool ends it; reopen the node so it
  // drops its cloud.
  useEffect(
    () =>
      onSessionRejected((reason) => {
        setSessionEnded(reason);
        void reopen();
      }),
    [reopen],
  );
  const library = useLibrary(node);
  const storage = useStorage(node);
  const work = useForegroundWork(node, library, storage);

  const { loadMore } = library;
  const loadMoreQuietly = useCallback(() => void loadMore(), [loadMore]);

  /**
   * The viewer, owned here rather than by the grid.
   *
   * A row is mounted and unmounted as it scrolls; the viewer has to outlive
   * every one of them, because it is opened from a tile and must survive that
   * tile being recycled while somebody is looking at the picture. See
   * `useLibraryViewer`.
   */
  const viewer = useLibraryViewer(
    {
      onFetch: library.fetchBlob,
      onFetchRendition: library.fetchRendition,
      onDeriveNow: library.deriveNow,
      onOpenForViewer: library.openForViewer,
      onOpenMotion: library.openMotion,
      onReadInfo: library.readInfo,
      onDelete: library.deleteRecord,
      captions: library.captions,
      onLoadMore: loadMoreQuietly,
    },
    library.items,
  );

  // Laid out against the window's current width, so a rotation re-flows the rows
  // rather than leaving them measured for the old one. Landscape keeps the rows
  // clear of a display cutout at either side.
  const gridWidth = landscape ? window.width - insets.left - insets.right : window.width;
  const columns = libraryColumns(window);
  const rows = useMemo(
    () => libraryRows(library.items, gridWidth, columns),
    [library.items, gridWidth, columns],
  );

  const openItem = viewer.open;
  const renderRow = useCallback(
    ({ item }: { item: LibraryGridRow }) => <LibraryRow row={item} onOpen={openItem} />,
    [openItem],
  );

  /**
   * Drop the decoded bitmaps when the app leaves the foreground.
   *
   * `expo-image` keeps Glide's memory cache alive across an unmount, which is
   * what makes scrolling back up instant and is also what a process about to be
   * frozen is holding when Android decides which app to kill.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") void Image.clearMemoryCache();
    });
    return () => subscription.remove();
  }, []);

  /**
   * What the grid says when it has nothing to draw: "No photos yet" only once a
   * read has finished and found none. Before the first read — while the node is
   * still opening — the grid does not know, and said "No photos yet" anyway.
   */
  const empty = (
    <Text style={[styles.muted, styles.listGutter, { paddingTop: 24 }]}>
      {library.loaded && !library.loading ? "No photos yet." : "Loading…"}
    </Text>
  );

  /**
   * The one thing that can sit above the grid: a way back to the camera roll
   * after a person refused access to it. Without it a refusal would be final,
   * because nothing else in the app asks again.
   */
  const accessPrompt =
    work.mediaAccess === "denied" || work.mediaAccess === "blocked" ? (
      <View style={[styles.listGutter, { gap: 10, paddingVertical: 16 }]}>
        <Text style={styles.muted}>
          Starkeep needs access to your photos to add them to your library.
        </Text>
        <Pressable onPress={() => void work.requestMediaAccess()} style={styles.button}>
          <Text style={styles.buttonLabel}>
            {work.mediaAccess === "blocked" ? "Open settings" : "Allow access"}
          </Text>
        </Pressable>
      </View>
    ) : null;

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const { importWithoutPull } = work;
  const confirmImportWithoutAccount = useCallback(() => {
    Alert.alert(
      "Import without signing in?",
      "Sign in first if you have used Starkeep on another device or in an earlier install of this app. " +
        "A phone that imports first and signs in later can bring back photos you deleted, " +
        "and can overwrite details your other devices recorded.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Import", onPress: importWithoutPull },
      ],
    );
  }, [importWithoutPull]);
  const confirmImportBeforeSync = useCallback(() => {
    Alert.alert(
      "Import before your library arrives?",
      "Your library tells this phone which of its photos your other devices already hold, " +
        "and which ones you deleted. Importing before it arrives can bring back photos you deleted, " +
        "and can overwrite details your other devices recorded.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Import", onPress: importWithoutPull },
      ],
    );
  }, [importWithoutPull]);

  /**
   * Signed in, and waiting for the first pull's rows. Photos from the cloud
   * arrive in the grid meanwhile, and the camera roll's do not, so the screen
   * says why. Automatic syncs wait for Wi-Fi, so the button lets a person
   * spend their own data now. A phone that cannot reach the cloud would hold
   * the import forever, so the escape hatch is here too, behind its own
   * confirmation.
   */
  const firstPullNotice =
    work.importGate === "first-pull" ? (
      <View style={[styles.listGutter, { gap: 10, paddingVertical: 16 }]}>
        <Text style={styles.muted}>
          {work.syncing
            ? "Syncing your library. The photos on this phone appear once your library arrives."
            : "The photos on this phone appear once your library arrives from the cloud."}
        </Text>
        {work.syncing ? (
          <ActivityIndicator color={colors.muted} />
        ) : (
          <Pressable onPress={work.syncNow} style={styles.button}>
            <Text style={styles.buttonLabel}>Sync now</Text>
          </Pressable>
        )}
        <Pressable onPress={confirmImportBeforeSync} style={{ alignSelf: "center", paddingVertical: 8 }}>
          <Text style={styles.linkLabel}>Import without waiting</Text>
        </Pressable>
      </View>
    ) : null;

  const signInFirst =
    work.importGate === "sign-in" ? (
      <View style={[styles.content, { flex: 1, paddingBottom: insets.bottom + 8 }]}>
        <View style={styles.centered}>
          <Text style={[styles.body, { textAlign: "center" }]}>
            Sign in to sync this phone with your Starkeep library. The photos on this phone appear
            once your library arrives.
          </Text>
          <Pressable onPress={onConnect} style={styles.button}>
            <Text style={styles.buttonLabel}>Sign in to Starkeep Cloud</Text>
          </Pressable>
        </View>
        <Pressable onPress={confirmImportWithoutAccount} style={{ alignSelf: "center", paddingVertical: 8 }}>
          <Text style={styles.linkLabel}>Import without signing in</Text>
        </Pressable>
      </View>
    ) : null;

  return (
    <View style={styles.safe}>
      {landscape ? null : (
        <AppBar topInset={insets.top} onOpenSettings={() => setSettingsOpen(true)} />
      )}
      {/* **A list, not a `ScrollView`, and the library's rows are its items.**
          A wrapping `View` inside a scroll view never unmounts anything, so
          every tile ever loaded would stay mounted with its bitmap decoded.
          Paging the library and virtualizing it are one change rather than
          two — a paginated grid that never releases a tile is worse than the
          ceiling it replaces. */}
      {signInFirst ?? (
        <FlatList
          data={rows}
          keyExtractor={libraryRowKey}
          renderItem={renderRow}
          contentContainerStyle={{
            paddingTop: landscape ? insets.top : 0,
            paddingBottom: insets.bottom + GRID_GAP,
            paddingLeft: landscape ? insets.left : 0,
            paddingRight: landscape ? insets.right : 0,
          }}
          ListHeaderComponent={firstPullNotice ?? accessPrompt}
          ListEmptyComponent={empty}
          // Only a spinner while the next page loads. Nothing else sits below the
          // grid, so the end of the content is the end of the tiles and
          // `onEndReached` fires when somebody actually reaches it.
          ListFooterComponent={
            library.loadingMore ? (
              <ActivityIndicator color={colors.muted} style={{ marginVertical: 16 }} />
            ) : null
          }
          onEndReachedThreshold={0.5}
          onEndReached={loadMoreQuietly}
          // Roughly two screens of tiles resident. Enough that a flick does not
          // outrun the renderer, few enough that the decoded bitmaps stay bounded
          // no matter how far the library is scrolled.
          windowSize={5}
          initialNumToRender={7}
          maxToRenderPerBatch={6}
          // **No `removeClippedSubviews`.** It detaches an item's native views
          // while the item stays mounted, which on Android is half of the blank
          // rectangle somebody sees scrolling back over pictures they were just
          // looking at. `windowSize` already bounds how many rows are resident,
          // and it bounds it by unmounting, which releases the bitmaps.
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor="#888"
              onRefresh={() => {
                setRefreshing(true);
                // The spinner waits for the grid only. The catch-up imports,
                // syncs and derives, which can take far longer than a pull should
                // hold the spinner; the grid reloads again as its work lands.
                void work.catchUpNow();
                void library.reload().finally(() => setRefreshing(false));
              }}
            />
          }
        />
      )}
      {viewer.element}
      {settingsOpen ? (
        <SettingsScreen
          node={node}
          storage={storage}
          work={work}
          sessionEnded={sessionEnded}
          onSignIn={onConnect}
          onSignedOut={reopen}
          onClose={closeSettings}
        />
      ) : null}
    </View>
  );
}
