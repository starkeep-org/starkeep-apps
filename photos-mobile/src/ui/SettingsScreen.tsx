/**
 * The device's settings, behind the grid's menu: who the phone is signed in
 * as, a manual sync, and what the phone keeps of the library.
 *
 * Drawn over the grid rather than in place of it, so the grid keeps its scroll
 * position and its decoded tiles while this is open — the same arrangement the
 * viewer uses.
 */

import { useEffect, useState } from "react";
import { BackHandler, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialIcons } from "@expo/vector-icons";
import { STAND_IN_CATEGORIES } from "@starkeep/protocol-primitives";
import { hostLabel } from "../auth/connection";
import { signOutThisPhone } from "../platform";
import { CEILING_CATEGORY_LABELS, ceilingLabel } from "./ceiling-text";
import { describeStorageGroup } from "./storage-text";
import { describeUploads } from "./upload-text";
import { formatBytes } from "./format";
import { colors, CONTENT_PADDING, styles } from "./theme";
import type { ForegroundWork } from "./use-foreground-work";
import type { NodeState, StorageState } from "./use-library";

export function SettingsScreen({
  node,
  storage,
  work,
  sessionEnded,
  onSignIn,
  onSignedOut,
  onClose,
}: {
  readonly node: NodeState;
  readonly storage: StorageState;
  readonly work: ForegroundWork;
  /** Why the pool ended this phone's sign-in, when it did. */
  readonly sessionEnded: string | null;
  readonly onSignIn: () => void;
  /** Reopen the node so it drops its cloud. */
  readonly onSignedOut: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  // The numbers move while the app syncs, and this screen is where somebody
  // looks at them.
  const { refresh } = storage;
  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <View style={[styles.overlay, { paddingTop: insets.top }]}>
      <View style={styles.appBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={onClose}
          style={styles.iconButton}
        >
          <MaterialIcons name="arrow-back" size={24} color={colors.heading} />
        </Pressable>
        <Text style={styles.appBarTitle}>Settings</Text>
      </View>
      <ScrollView
        contentContainerStyle={{
          padding: CONTENT_PADDING,
          paddingBottom: CONTENT_PADDING + insets.bottom,
          paddingLeft: CONTENT_PADDING + insets.left,
          paddingRight: CONTENT_PADDING + insets.right,
          gap: 28,
        }}
      >
        <AccountSection
          node={node}
          sessionEnded={sessionEnded}
          syncing={work.syncing}
          onSignIn={onSignIn}
          onSignedOut={onSignedOut}
        />
        {node.status === "ready" && node.connection ? <SyncSection work={work} /> : null}
        <StorageSection storage={storage} />
      </ScrollView>
    </View>
  );
}

function AccountSection({
  node,
  sessionEnded,
  syncing,
  onSignIn,
  onSignedOut,
}: {
  readonly node: NodeState;
  readonly sessionEnded: string | null;
  readonly syncing: boolean;
  readonly onSignIn: () => void;
  readonly onSignedOut: () => Promise<void>;
}) {
  /**
   * Whether "Sign out" is armed. Two taps rather than one, because afterwards
   * the phone syncs again only once its owner signs in.
   */
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connection = node.status === "ready" ? node.connection : null;

  return (
    <Section title="Account">
      {connection ? (
        <>
          <Text style={styles.body}>
            {`Signed in to ${hostLabel(connection.baseUrl)} as ${connection.email ?? "you"}.`}
          </Text>
          <Pressable
            onPress={() => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              setConfirming(false);
              void signOutThisPhone()
                .then(onSignedOut)
                .catch((err: unknown) => setError(String(err)));
            }}
            disabled={syncing}
            style={{ paddingVertical: 8 }}
          >
            <Text style={confirming ? styles.error : styles.linkLabel}>
              {confirming ? "Tap again to sign out. Syncing stops until you sign in again." : "Sign out"}
            </Text>
          </Pressable>
        </>
      ) : (
        <>
          {sessionEnded ? (
            <Text style={styles.error}>
              Your sign-in ended ({sessionEnded}). Sign in again to keep syncing.
            </Text>
          ) : null}
          <Text style={styles.muted}>
            Sign in with the Starkeep account your admin created to sync this phone&rsquo;s photos.
          </Text>
          {node.status === "ready" ? (
            <Pressable onPress={onSignIn} style={styles.button}>
              <Text style={styles.buttonLabel}>Sign in</Text>
            </Pressable>
          ) : null}
        </>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Section>
  );
}

/**
 * A sync on demand. Automatic sync waits for Wi-Fi, because it uploads
 * originals; this button does not wait, because a tap is a person deciding to
 * spend their own data.
 */
function SyncSection({ work }: { readonly work: ForegroundWork }) {
  return (
    <Section title="Sync">
      <Pressable
        onPress={work.syncNow}
        disabled={work.syncing}
        style={[styles.button, work.syncing ? styles.buttonDisabled : null]}
      >
        <Text style={styles.buttonLabel}>{work.syncing ? "Syncing…" : "Sync now"}</Text>
      </Pressable>
      {/* Only a failure says anything. A sync that stopped short with no line
          under the button would look like a button that does nothing. */}
      {!work.syncing && work.syncError ? <Text style={styles.error}>{work.syncError}</Text> : null}
      {/* Uploads run beside the syncs, so the button finishing says nothing
          about the files. This line does. */}
      {describeUploads(work.uploads) ? (
        <Text style={styles.muted}>{describeUploads(work.uploads)}</Text>
      ) : null}
    </Section>
  );
}

function StorageSection({ storage }: { readonly storage: StorageState }) {
  const { report, ceilings } = storage;
  return (
    <Section title="Storage">
      {report ? (
        <>
          <Text style={styles.body}>{formatBytes(report.heldBytes)} held on this device</Text>
          {Object.entries(report.groups)
            // Only groups holding something, largest first: what is filling the
            // disk is the question being asked.
            .filter(([, bytes]) => bytes > 0)
            .sort(([, a], [, b]) => b - a)
            .map(([group, bytes]) => (
              <View key={group} style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.body}>{describeStorageGroup(group)}</Text>
                  <Text style={styles.muted}>{formatBytes(bytes)}</Text>
                </View>
              </View>
            ))}
        </>
      ) : null}

      {ceilings ? (
        <View style={{ gap: 12, marginTop: 8 }}>
          {/* The platform's ceilings for this node, shown here because a phone
              has no admin-web. Same categories and sizes as admin-web's
              "Sync-down ceilings". Raising one downloads the sizes it now
              covers. */}
          <Text style={styles.body}>Sync-down ceilings</Text>
          {STAND_IN_CATEGORIES.map((category) => {
            const current = ceilings.current[category];
            const canonical = ceilings.canonical[category];
            const options: (number | null)[] = [null, ...ceilings.choices[category]];
            return (
              <View key={category} style={{ gap: 6 }}>
                <Text style={styles.muted}>
                  {CEILING_CATEGORY_LABELS[category]}
                  {current === ceilings.defaults[category] ? " (default)" : ""}
                </Text>
                <View style={styles.chips}>
                  {options.map((choice) => {
                    const selected = current === choice;
                    return (
                      <Pressable
                        key={String(choice)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        accessibilityLabel={`${CEILING_CATEGORY_LABELS[category]} ceiling ${ceilingLabel(category, choice, canonical)}`}
                        onPress={() => storage.setCeiling(category, choice)}
                        style={[styles.chip, selected ? styles.chipSelected : null]}
                      >
                        <Text style={selected ? styles.chipLabelSelected : styles.chipLabel}>
                          {ceilingLabel(category, choice, canonical)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
      {storage.error ? <Text style={styles.error}>{storage.error}</Text> : null}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}
