/**
 * Sign-in — which connects this node to a cloud, and is never a way in.
 *
 * The app works without ever reaching this screen; what it buys is sync. So it
 * is reached by asking and can always be backed out of, and `onCancel` is not a
 * courtesy: a sign-in screen with no way out is a gate whatever the shell calls
 * it, and someone who opened it to see what it said would be stuck behind a
 * login to get back to their own photos.
 *
 * Two states in one screen: the password you were given, and — when Cognito
 * says the password was temporary — the password you are choosing. Keeping them
 * in one component is what lets the second carry the session from the first
 * without a navigator, which this app does not have and does not yet need.
 */

import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CognitoError, type AuthTokens, type CognitoClient } from "../auth/cognito";
import { styles } from "./theme";

interface Props {
  readonly client: CognitoClient;
  readonly poolLabel: string;
  readonly onSignedIn: (tokens: AuthTokens) => void;
  readonly onCancel: () => void;
}

export function SignInScreen({ client, poolLabel, onSignedIn, onCancel }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  /** Non-null once Cognito has told us the password was a temporary one. */
  const [challengeSession, setChallengeSession] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    email.trim().length > 0 &&
    (challengeSession ? newPassword.length > 0 : password.length > 0) &&
    !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (challengeSession) {
        onSignedIn(await client.setNewPassword(email.trim(), challengeSession, newPassword));
        return;
      }
      const result = await client.signIn(email.trim(), password);
      if (result.kind === "tokens") {
        onSignedIn(result.tokens);
      } else {
        setChallengeSession(result.session);
        setPassword("");
      }
    } catch (err) {
      // Cognito's own message is the useful one ("Incorrect username or
      // password", "Password did not conform with policy: ..."), so it is shown
      // rather than replaced with something friendlier and vaguer.
      setError(err instanceof CognitoError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.centered}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={{ width: "100%", paddingHorizontal: 24, gap: 16 }}>
          <View style={{ gap: 4, marginBottom: 8 }}>
            <Text style={styles.title}>Connect</Text>
            <Text style={styles.subtitle}>
              {challengeSession
                ? "Choose a password"
                : `Sign in to ${poolLabel} to sync this device`}
            </Text>
          </View>

          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="username"
            editable={!challengeSession && !busy}
            value={email}
            onChangeText={setEmail}
          />

          {challengeSession ? (
            <>
              <Text style={styles.muted}>
                That password was a temporary one. Set a new password to finish signing in.
              </Text>
              <TextInput
                style={styles.input}
                placeholder="New password"
                placeholderTextColor="#666"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                textContentType="newPassword"
                editable={!busy}
                value={newPassword}
                onChangeText={setNewPassword}
                onSubmitEditing={() => canSubmit && void submit()}
              />
            </>
          ) : (
            <TextInput
              style={styles.input}
              placeholder="Password"
              placeholderTextColor="#666"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              textContentType="password"
              editable={!busy}
              value={password}
              onChangeText={setPassword}
              onSubmitEditing={() => canSubmit && void submit()}
            />
          )}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={[styles.button, !canSubmit && styles.buttonDisabled]}
            disabled={!canSubmit}
            onPress={() => void submit()}
          >
            {busy ? (
              <ActivityIndicator color="#111" />
            ) : (
              <Text style={styles.buttonLabel}>
                {challengeSession ? "Set password and sign in" : "Sign in"}
              </Text>
            )}
          </Pressable>

          <Pressable onPress={onCancel} disabled={busy} style={{ paddingVertical: 8 }}>
            <Text style={[styles.linkLabel, { textAlign: "center" }]}>
              Not now — this device works without it
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
