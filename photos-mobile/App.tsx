import { useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { HomeScreen } from "./src/ui/HomeScreen";
import { SignInScreen } from "./src/ui/SignInScreen";
import { closeNodeForReset } from "./src/work/node-handle";

/**
 * The app shell (item 12b).
 *
 * ## There is no sign-in gate, and there must not be one
 *
 * The app opens into the node. Connecting to a cloud is an action you may take
 * from inside it, not a door you pass through to reach it.
 *
 * The reason is not convenience. The photos and videos on this handset are the
 * user's, they are already on the device, and Android has already decided who
 * may read them — that decision is the OS permission, and it is *the* access
 * control for local media. Putting a login in front of them would be this app
 * inventing a second, weaker gate in front of a door the user already holds
 * the key to, and then failing shut on it when the network is down.
 *
 * Signing in buys exactly one thing: **sync**. The person signs in with the
 * account an admin created, which names the cloud the phone syncs to. A
 * signed-out phone is a perfectly good Starkeep node that happens to be the
 * only one that knows what it holds.
 *
 * ## What that leaves the shell doing
 *
 * Choosing between two screens, neither of which is a precondition for the
 * other: the node, and — when you ask for it from Settings — the sign-in. No
 * navigator: Settings and the viewer open over the grid inside `HomeScreen`,
 * which keeps the grid and the work that keeps it current alive underneath.
 */

/**
 * `SafeAreaProvider` sits outside the shell because both screens the shell
 * chooses between read the safe-area insets, and the provider is what measures
 * them. Wrapping the shell rather than each screen keeps that
 * single measurement across the switch between them.
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <AppShell />
    </SafeAreaProvider>
  );
}

function AppShell() {
  const [signingIn, setSigningIn] = useState(false);

  // Reached by asking, and escapable without signing in. A sign-in you cannot
  // back out of is a gate.
  if (signingIn) {
    return (
      <SignInScreen
        onCancel={() => setSigningIn(false)}
        onSignedIn={async () => {
          // The node reads the session when it opens, so the next one must be a
          // fresh one. The home screen opens it when it mounts again.
          await closeNodeForReset();
          setSigningIn(false);
        }}
      />
    );
  }

  return <HomeScreen onConnect={() => setSigningIn(true)} />;
}
