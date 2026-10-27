/**
 * Signing this phone in to sync.
 *
 * The person types the cloud's address and taps "Sign in". The cloud's sign-in
 * page opens in the system browser, which shows its real address and offers
 * the browser's saved passwords; the page asks for the email and password, and
 * for a new password at an account's first sign-in. This app never sees the
 * password. Back from the page, the phone registers its attested key and keeps
 * the session in the secure store.
 *
 * Reached by asking and always escapable: the app works without ever reaching
 * this screen, and what it buys is sync.
 */

import { useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { checkCloudAddress } from "../auth/session";
import { SignInCancelledError } from "../auth/browser-sign-in";
import { signIn } from "../platform";
import { styles } from "./theme";

interface Props {
  /** Bring the node up with the new session. */
  readonly onSignedIn: () => Promise<void>;
  readonly onCancel: () => void;
  /** The cloud this phone last knew, to fill the address in. */
  readonly initialAddress?: string;
}

export function SignInScreen({ onSignedIn, onCancel, initialAddress }: Props) {
  const [address, setAddress] = useState(initialAddress ?? "");
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit() {
    setProblem(null);
    const checked = checkCloudAddress(address);
    if (!checked.ok) {
      setProblem(checked.reason);
      return;
    }
    setWorking(true);
    try {
      await signIn({ baseUrl: checked.baseUrl });
      await onSignedIn();
    } catch (err) {
      // Closing the sign-in page is a change of mind, not a failure.
      if (!(err instanceof SignInCancelledError)) {
        setProblem(err instanceof Error ? err.message : String(err));
      }
      setWorking(false);
    }
  }

  const ready = address.trim() !== "";

  return (
    <SafeAreaView style={styles.safe}>
      <View style={[styles.content, { flex: 1, justifyContent: "center" }]}>
        <View style={{ gap: 4 }}>
          <Text style={styles.title}>Sign in</Text>
          <Text style={styles.subtitle}>Sync this phone with your cloud</Text>
        </View>
        <Text style={styles.muted}>
          Enter the cloud&rsquo;s address your admin sent. You sign in on your cloud&rsquo;s own page, in the browser.
        </Text>
        <TextInput
          style={styles.input}
          placeholder="https://…"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={address}
          onChangeText={setAddress}
          editable={!working}
        />
        {working ? (
          <ActivityIndicator />
        ) : (
          <Pressable onPress={() => void submit()} disabled={!ready} style={[styles.button, !ready && { opacity: 0.5 }]}>
            <Text style={styles.buttonLabel}>Sign in</Text>
          </Pressable>
        )}
        {problem ? <Text style={styles.error}>{problem}</Text> : null}
        {working ? null : (
          <Pressable onPress={onCancel} style={{ paddingVertical: 8 }}>
            <Text style={styles.linkLabel}>Cancel</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}
