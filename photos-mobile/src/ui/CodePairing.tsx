/**
 * Connecting this phone with a pairing code, for when no admin-web is at hand
 * to show a QR code — a member joining someone else's cloud.
 *
 * The phone makes its own key and shows a code holding only the public half.
 * The person sends the code to an admin of the cloud, who approves it in
 * admin-web after reading back the fingerprint. This screen asks the cloud
 * every few seconds and connects on the first answer. The waiting key survives
 * closing the app.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Share, Text, TextInput, View } from "react-native";
import type { CodePairing as Pending, DeviceCredential } from "../auth/device-key";
import {
  checkPairingByCode,
  clearPairingByCode,
  pendingPairingByCode,
  startPairingByCode,
} from "../platform";
import { styles } from "./theme";

/** How often a waiting phone asks the cloud again. */
const CHECK_INTERVAL_MS = 5_000;

interface Props {
  /** Keep the approved credential and bring the node up with a cloud. */
  readonly onPaired: (credential: DeviceCredential) => Promise<void>;
}

export function CodePairing({ onPaired }: Props) {
  const [pending, setPending] = useState<Pending | null | undefined>(undefined);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    void pendingPairingByCode().then(setPending);
  }, []);

  const check = useCallback(async (waiting: Pending) => {
    try {
      if (!(await checkPairingByCode(waiting.credential))) return;
      setConnecting(true);
      await onPaired(waiting.credential);
      await clearPairingByCode();
    } catch (err) {
      setProblem(`Could not reach the cloud: ${String(err)}`);
    }
  }, [onPaired]);

  useEffect(() => {
    if (!pending || connecting) return;
    void check(pending);
    const timer = setInterval(() => void check(pending), CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pending, connecting, check]);

  async function start() {
    setProblem(null);
    const result = await startPairingByCode(address, label.trim() || null);
    if ("ok" in result) {
      setProblem(result.reason);
      return;
    }
    setPending(result);
  }

  let body: ReactNode;
  if (pending === undefined || connecting) {
    body = <ActivityIndicator />;
  } else if (pending === null) {
    body = (
      <>
        <Text style={styles.muted}>
          Enter the address of the cloud you are joining. Its admin can tell you what it is.
        </Text>
        <TextInput
          style={styles.input}
          placeholder="https://…"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={address}
          onChangeText={setAddress}
        />
        <TextInput
          style={styles.input}
          placeholder="Name this phone"
          value={label}
          maxLength={100}
          onChangeText={setLabel}
        />
        <Pressable onPress={() => void start()} style={styles.button}>
          <Text style={styles.buttonLabel}>Make a pairing code</Text>
        </Pressable>
      </>
    );
  } else {
    body = (
      <>
        <Text style={styles.body}>
          Send this code to an admin of <Text style={styles.mono}>{pending.credential.baseUrl}</Text>. It
          holds no secret.
        </Text>
        <Text selectable style={[styles.mono, { fontSize: 12 }]}>
          {pending.code}
        </Text>
        <Pressable onPress={() => void Share.share({ message: pending.code })} style={styles.button}>
          <Text style={styles.buttonLabel}>Share the code</Text>
        </Pressable>
        <Text style={styles.body}>
          When the admin approves it, they will read you a fingerprint. It should be{" "}
          <Text style={styles.mono}>{pending.fingerprint}</Text>.
        </Text>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <ActivityIndicator />
          <Text style={styles.muted}>Waiting for the admin to approve this phone…</Text>
        </View>
        <Pressable
          onPress={() => void clearPairingByCode().then(() => setPending(null))}
          style={{ paddingVertical: 8 }}
        >
          <Text style={styles.linkLabel}>Start over</Text>
        </Pressable>
      </>
    );
  }

  return (
    <>
      {body}
      {problem ? <Text style={styles.error}>{problem}</Text> : null}
    </>
  );
}
