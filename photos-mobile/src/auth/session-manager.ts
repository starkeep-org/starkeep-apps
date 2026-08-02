/**
 * When a session is live, when it is merely offline, and when it is over.
 *
 * ## Why this is not in the app shell
 *
 * It started there, as a `try`/`catch` around a refresh, and that shape had a
 * bug that no amount of care in a React effect would have surfaced: the `catch`
 * cleared the stored refresh token, so a launch with no network signed the
 * device out *permanently*. A revoked credential and a tunnel look identical
 * from inside a `catch`, and only one of them should cost you your session.
 *
 * Pulled out here, the policy is three cases over a fake client, and the
 * offline case is a test rather than a thing you find out about on a train.
 *
 * ## The local-first rule this encodes
 *
 * **Nothing waits on the network to decide whether you are signed in.**
 * {@link loadStoredSession} reads a file and returns; the app is usable at that
 * point. {@link refreshSession} runs afterwards and can only ever *upgrade* the
 * session to live or — on an explicit rejection from the pool — end it. A
 * device that has signed in once works offline from then on, because the thing
 * that proves who you are is on the device, not on the far side of a request.
 */

import { CognitoError, emailFromIdToken, type AuthTokens, type CognitoClient } from "./cognito";
import type { SessionStore } from "./session-store";

export interface ActiveSession {
  readonly email: string | null;
  readonly refreshToken: string;
  /**
   * Null when this launch has not reached Cognito yet — either because the
   * refresh is still in flight, or because there is no network.
   *
   * Not an error state. Nothing on the phone needs an access token today: the
   * local node reads its own database and its own object store, and the cloud
   * data plane is unreachable for unrelated reasons. So a token-less session is
   * a fully working app, and the day something does need one is the day it
   * should ask for a refresh — not launch.
   */
  readonly tokens: AuthTokens | null;
}

export type RefreshOutcome =
  /** The pool answered and the session is now live. */
  | { readonly kind: "live"; readonly session: ActiveSession }
  /** The pool could not be reached. The session stands, unrefreshed. */
  | { readonly kind: "offline"; readonly reason: string }
  /** The pool rejected the refresh token. The session is over and cleared. */
  | { readonly kind: "rejected"; readonly reason: string };

/** The session this device already has, from disk. Never touches the network. */
export async function loadStoredSession(store: SessionStore): Promise<ActiveSession | null> {
  const stored = await store.read();
  if (!stored) return null;
  return { email: stored.email, refreshToken: stored.refreshToken, tokens: null };
}

/** The session a completed sign-in produces. */
export function sessionFromTokens(tokens: AuthTokens): ActiveSession {
  return {
    email: emailFromIdToken(tokens.idToken),
    refreshToken: tokens.refreshToken,
    tokens,
  };
}

export async function refreshSession(
  client: CognitoClient,
  store: SessionStore,
  session: ActiveSession,
): Promise<RefreshOutcome> {
  try {
    const tokens = await client.refresh(session.refreshToken);
    const email = emailFromIdToken(tokens.idToken) ?? session.email;

    // Written back only when something actually changed. The email is normally
    // learned at sign-in, but a session restored from an older write may not
    // have one, and a refresh is where it turns up.
    if (email !== session.email || tokens.refreshToken !== session.refreshToken) {
      await store.write({ refreshToken: tokens.refreshToken, email });
    }
    return {
      kind: "live",
      session: { email, refreshToken: tokens.refreshToken, tokens },
    };
  } catch (err) {
    // The whole point of the split. Only a 4xx is the pool saying *this
    // credential is no good* — a 5xx, a DNS failure, a captive portal and a
    // dropped connection all mean "ask again later", and discarding a working
    // refresh token on any of them is how being briefly offline turns into
    // being signed out for good.
    if (err instanceof CognitoError && err.status >= 400 && err.status < 500) {
      await store.clear();
      return { kind: "rejected", reason: err.message };
    }
    return { kind: "offline", reason: err instanceof Error ? err.message : String(err) };
  }
}
