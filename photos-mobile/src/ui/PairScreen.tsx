/**
 * Connecting this phone, two ways.
 *
 * - **Scan admin-web's code.** The code carries this phone's key and the cloud
 *   it syncs to, so scanning it is the whole of connecting. The rules — ask
 *   before connecting, report a bad code once — live in `pair-flow.ts`, where
 *   they can be tested without a camera.
 * - **Show a pairing code** (`CodePairing.tsx`), for joining a cloud whose
 *   admin-web is not at hand. The phone makes its own key and an admin
 *   approves it.
 *
 * Reached by asking and always escapable, for the reason sign-in was: the app
 * works without ever reaching this screen, and what it buys is sync.
 */

import { useReducer, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { SafeAreaView } from "react-native-safe-area-context";
import type { DeviceCredential } from "../auth/device-key";
import { isScanning, pairFlow, PAIR_FLOW_START } from "./pair-flow";
import { CodePairing } from "./CodePairing";
import { styles } from "./theme";

interface Props {
  /** Keep the credential and bring the node up with a cloud. Rejects on failure. */
  readonly onPaired: (credential: DeviceCredential) => Promise<void>;
  readonly onCancel: () => void;
}

export function PairScreen({ onPaired, onCancel }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [state, dispatch] = useReducer(pairFlow, PAIR_FLOW_START);
  const [byCode, setByCode] = useState(false);

  const cancel = (
    <Pressable onPress={onCancel} style={{ paddingVertical: 8 }}>
      <Text style={styles.linkLabel}>Cancel</Text>
    </Pressable>
  );

  let body: ReactNode;
  if (byCode) {
    body = <CodePairing onPaired={onPaired} />;
  } else if (!permission) {
    body = <ActivityIndicator />;
  } else if (!permission.granted) {
    body = (
      <>
        <Text style={styles.body}>
          Starkeep needs the camera to read the pairing code admin-web shows.
        </Text>
        {permission.canAskAgain ? (
          <Pressable onPress={() => void requestPermission()} style={styles.button}>
            <Text style={styles.buttonLabel}>Allow the camera</Text>
          </Pressable>
        ) : (
          <Text style={styles.muted}>
            Camera access is turned off for Starkeep. Turn it on in the phone&rsquo;s Settings,
            then come back.
          </Text>
        )}
      </>
    );
  } else if (state.kind === "scanning") {
    body = (
      <>
        <Text style={styles.muted}>
          In admin-web, open Paired phones, name this phone and choose Pair a phone. Then point
          the camera at the code.
        </Text>
        <View style={{ width: "100%", aspectRatio: 1, overflow: "hidden", borderRadius: 8 }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={
              isScanning(state) ? (result) => dispatch({ type: "scanned", data: result.data }) : undefined
            }
          />
        </View>
        {state.problem ? <Text style={styles.error}>{state.problem}</Text> : null}
      </>
    );
  } else if (state.kind === "confirming") {
    const { credential, host } = state;
    body = (
      <>
        <Text style={styles.body}>
          Connect to <Text style={styles.mono}>{host}</Text>
          {credential.label ? ` as “${credential.label}”` : ""}?
        </Text>
        <Text style={styles.muted}>
          This phone will back up its photos to that cloud. Only connect to a code your own
          admin-web is showing.
        </Text>
        <Pressable
          onPress={() => {
            dispatch({ type: "connect" });
            onPaired(credential).catch((err: unknown) =>
              dispatch({ type: "failed", message: String(err) }),
            );
          }}
          style={styles.button}
        >
          <Text style={styles.buttonLabel}>Connect</Text>
        </Pressable>
        <Pressable onPress={() => dispatch({ type: "rescan" })} style={{ paddingVertical: 8 }}>
          <Text style={styles.linkLabel}>Scan a different code</Text>
        </Pressable>
      </>
    );
  } else if (state.kind === "connecting") {
    body = (
      <>
        <ActivityIndicator />
        <Text style={styles.muted}>Connecting to {state.host}…</Text>
      </>
    );
  } else {
    body = (
      <>
        <Text style={styles.error}>Could not connect: {state.message}</Text>
        <Pressable onPress={() => dispatch({ type: "rescan" })} style={styles.button}>
          <Text style={styles.buttonLabel}>Scan again</Text>
        </Pressable>
      </>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={[styles.content, { flex: 1, justifyContent: "center" }]}>
        <View style={{ gap: 4 }}>
          <Text style={styles.title}>Connect</Text>
          <Text style={styles.subtitle}>
            {byCode ? "Send a pairing code to an admin" : "Scan admin-web\u2019s pairing code"}
          </Text>
        </View>
        {body}
        {!byCode && state.kind === "scanning" ? (
          <Pressable onPress={() => setByCode(true)} style={{ paddingVertical: 8 }}>
            <Text style={styles.linkLabel}>No admin-web here? Use a pairing code</Text>
          </Pressable>
        ) : null}
        {state.kind === "connecting" ? null : cancel}
      </View>
    </SafeAreaView>
  );
}
