/**
 * Signing this phone in to sync.
 *
 * The person types the cloud's address and the email and password of the
 * account an admin created. The phone asks the cloud how its devices sign in,
 * signs in through the pool's device client, and keeps the session in the
 * secure store. An account's first sign-in asks for a new password to replace
 * the temporary one, here, in place.
 *
 * Reached by asking and always escapable: the app works without ever reaching
 * this screen, and what it buys is sync.
 */

import { useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { checkCloudAddress } from "../auth/session";
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [needsNewPassword, setNeedsNewPassword] = useState(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit() {
    setProblem(null);
    const checked = checkCloudAddress(address);
    if (!checked.ok) {
      setProblem(checked.reason);
      return;
    }
    if (needsNewPassword && newPassword !== confirmPassword) {
      setProblem("The two new passwords do not match.");
      return;
    }
    setWorking(true);
    try {
      const outcome = await signIn({
        baseUrl: checked.baseUrl,
        email: email.trim(),
        password,
        ...(needsNewPassword ? { newPassword } : {}),
      });
      if (outcome.kind === "new-password-required") {
        setNeedsNewPassword(true);
        setWorking(false);
        return;
      }
      await onSignedIn();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      setWorking(false);
    }
  }

  const ready =
    address.trim() !== "" && email.trim() !== "" && password !== "" && (!needsNewPassword || newPassword.length >= 8);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={[styles.content, { flex: 1, justifyContent: "center" }]}>
        <View style={{ gap: 4 }}>
          <Text style={styles.title}>Sign in</Text>
          <Text style={styles.subtitle}>
            {needsNewPassword ? "Choose a new password" : "Sync this phone with your cloud"}
          </Text>
        </View>
        {needsNewPassword ? (
          <>
            <Text style={styles.muted}>
              This is the account&rsquo;s first sign-in. Choose a password to replace the temporary one.
            </Text>
            <TextInput
              style={styles.input}
              placeholder="New password, at least 8 characters"
              secureTextEntry
              autoComplete="new-password"
              textContentType="newPassword"
              value={newPassword}
              onChangeText={setNewPassword}
              editable={!working}
            />
            <TextInput
              style={styles.input}
              placeholder="New password again"
              secureTextEntry
              autoComplete="new-password"
              textContentType="newPassword"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              editable={!working}
            />
          </>
        ) : (
          <>
            <Text style={styles.muted}>
              Enter the cloud&rsquo;s address and the account your admin created for you.
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
            <TextInput
              style={styles.input}
              placeholder="Email"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              textContentType="username"
              value={email}
              onChangeText={setEmail}
              editable={!working}
            />
            <TextInput
              style={styles.input}
              placeholder="Password"
              secureTextEntry
              autoComplete="current-password"
              textContentType="password"
              value={password}
              onChangeText={setPassword}
              editable={!working}
            />
          </>
        )}
        {working ? (
          <ActivityIndicator />
        ) : (
          <Pressable onPress={() => void submit()} disabled={!ready} style={[styles.button, !ready && { opacity: 0.5 }]}>
            <Text style={styles.buttonLabel}>{needsNewPassword ? "Set password and sign in" : "Sign in"}</Text>
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
