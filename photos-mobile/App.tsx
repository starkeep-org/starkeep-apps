import { useCallback, useEffect, useMemo, useState } from "react";
import { createCognitoClient } from "./src/auth/cognito";
import {
  loadStoredSession,
  refreshSession,
  sessionFromTokens,
  type ActiveSession,
} from "./src/auth/session-manager";
import { loadCloudConfig } from "./src/config";
import { sessionStore } from "./src/platform";
import { HomeScreen } from "./src/ui/HomeScreen";
import { SignInScreen } from "./src/ui/SignInScreen";

/**
 * The app shell (item 12b).
 *
 * ## There is no sign-in gate, and there must not be one
 *
 * The app opens into the node. Signing in is an action you may take from
 * inside it, not a door you pass through to reach it.
 *
 * The reason is not convenience. The photos and videos on this handset are the
 * user's, they are already on the device, and Android has already decided who
 * may read them — that decision is the OS permission, and it is *the* access
 * control for local media. Putting a Cognito login in front of them would be
 * this app inventing a second, weaker gate in front of a door the user already
 * holds the key to, and then failing shut on it when the network is down.
 *
 * Sign-in buys exactly one thing: **sync**. It is how this node proves itself
 * to the other nodes it exchanges with. A device with no session is a perfectly
 * good Starkeep node that happens to be the only one that knows what it holds.
 *
 * ## What that leaves the shell doing
 *
 * Choosing between two screens, neither of which is a precondition for the
 * other: the node, and — when you ask for it — sign-in. No navigator; the day
 * there is a stack to push onto is the day to add one.
 *
 * The session is read from a file and never awaited before rendering. The
 * Cognito refresh runs behind the screen you are already looking at, and can
 * only promote a session to live or, on a 4xx from the pool and nothing else,
 * end it. Any `await` on Cognito that happens before a screen is chosen puts
 * the app's usability back on the far side of the network.
 */

export default function App() {
  const config = useMemo(() => loadCloudConfig(), []);
  const client = useMemo(
    () =>
      config
        ? createCognitoClient({
            region: config.region,
            userPoolClientId: config.userPoolClientId,
          })
        : null,
    [config],
  );

  const [session, setSession] = useState<ActiveSession | null>(null);
  /** False until the session file has been read — not a gate, just a label. */
  const [sessionKnown, setSessionKnown] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  // A file read, so this settles in milliseconds. It does not gate the UI: the
  // node screen renders while this is in flight and simply does not yet claim
  // to know whether the device has a session.
  useEffect(() => {
    let cancelled = false;
    void loadStoredSession(sessionStore).then((stored) => {
      if (cancelled) return;
      setSession(stored);
      setSessionKnown(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Make a stored session live. Also the pull-to-refresh handler, which is what
   * recovers an offline session once there is a connection again — the
   * alternative being to make people force-quit the app.
   */
  const tryRefresh = useCallback(async () => {
    if (!client || !session) return;
    const outcome = await refreshSession(client, sessionStore, session);
    if (outcome.kind === "live") setSession(outcome.session);
    if (outcome.kind === "rejected") setSession(null);
    // "offline" deliberately changes nothing. The session stands.
  }, [client, session]);

  const needsRefresh = session !== null && session.tokens === null;
  useEffect(() => {
    if (sessionKnown && needsRefresh) void tryRefresh();
    // Keyed on whether a refresh is *needed* rather than on `tryRefresh`, whose
    // identity changes with every session update — which would make a
    // successful refresh schedule the next one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKnown, needsRefresh]);

  // Reached by asking, and escapable without signing in. A sign-in you cannot
  // back out of is a gate wearing a different name.
  if (signingIn && client && config) {
    return (
      <SignInScreen
        client={client}
        poolLabel={config.region || "Starkeep"}
        onCancel={() => setSigningIn(false)}
        onSignedIn={(tokens) => {
          const signedIn = sessionFromTokens(tokens);
          setSession(signedIn);
          setSigningIn(false);
          void sessionStore.write({
            refreshToken: signedIn.refreshToken,
            email: signedIn.email,
          });
        }}
      />
    );
  }

  return (
    <HomeScreen
      session={session}
      sessionKnown={sessionKnown}
      config={config}
      canRefreshSession={client !== null && session !== null}
      onRefreshSession={tryRefresh}
      onConnect={client ? () => setSigningIn(true) : null}
      onSignOut={() => {
        setSession(null);
        void sessionStore.clear();
      }}
    />
  );
}
