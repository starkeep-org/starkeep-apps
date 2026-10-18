/**
 * This phone's sign-in: the person's Starkeep account, through the pool's
 * device client.
 *
 * ## Why a sign-in, and what it replaced
 *
 * A phone used to sync with a key an admin approved: a QR code from admin-web,
 * or a pairing code the phone showed and an admin pasted. Both needed a second
 * person. Signing in needs only the cloud's address and the account an admin
 * already created. The phone then syncs with the device client's ID token
 * alone; the cloud's device-token branch accepts no other client's token
 * without an app signature, and the identity pool does not trust the device
 * client, so the token reaches no AWS role.
 *
 * The sign-in, refresh and sign-out rules are protocol-primitives'
 * device-session module, the same code the local data server uses. This file
 * keeps the phone's side: where the session lives, and the cloud it belongs to.
 *
 * ## Where it is stored, and why there
 *
 * `expo-secure-store`, which is Keystore-encrypted at rest. The refresh token
 * lasts ten years, so it gets the storage the device key had before it. Only
 * the refresh token and the email are kept; ID tokens live fifteen minutes and
 * are re-obtained on demand.
 *
 * Separate items rather than one JSON value, because a Cognito refresh token
 * alone is close to the size where secure-store implementations start to warn.
 * A sign-out that has not reached the pool yet is kept as one more item, so a
 * phone signed out in a tunnel revokes its token at the next launch.
 */

import {
  createCognitoClient,
  fetchDeviceAuthConfig,
  idTokenClaims,
  parseDeviceAuthConfig,
  revokePendingSignOut,
  signOut,
  storeSignIn,
  type AuthTokens,
  type CognitoClient,
  type DeviceAuthConfig,
  type RevocationOutcome,
  type SessionStore,
} from "@starkeep/protocol-primitives";

/** Where secrets live. Supplied at the edge; see `platform.ts`. */
export interface SecureStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

const REFRESH_TOKEN_ITEM = "starkeep.session.refreshToken";
const EMAIL_ITEM = "starkeep.session.email";
const PENDING_REVOCATION_ITEM = "starkeep.session.pendingRevocation";
/** The cloud the session belongs to, and its pool: `{ baseUrl, auth }`. */
const CLOUD_ITEM = "starkeep.session.cloud";

/**
 * Hosts a development cloud answers on without TLS: the machine itself, and the
 * Android emulator's alias for the machine running it.
 */
const PLAIN_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

export function createSessionStore(store: SecureStore): SessionStore {
  return {
    async read() {
      const refreshToken = await store.getItemAsync(REFRESH_TOKEN_ITEM);
      if (!refreshToken) return null;
      return { refreshToken, email: await store.getItemAsync(EMAIL_ITEM) };
    },

    async write(session) {
      await store.setItemAsync(REFRESH_TOKEN_ITEM, session.refreshToken);
      if (session.email) await store.setItemAsync(EMAIL_ITEM, session.email);
      else await store.deleteItemAsync(EMAIL_ITEM);
    },

    async clear() {
      // The token first: if the process dies between the two, what is left is
      // an email with no session, which reads as signed out.
      await store.deleteItemAsync(REFRESH_TOKEN_ITEM);
      await store.deleteItemAsync(EMAIL_ITEM);
    },

    readPendingRevocation() {
      return store.getItemAsync(PENDING_REVOCATION_ITEM);
    },

    writePendingRevocation(refreshToken) {
      return store.setItemAsync(PENDING_REVOCATION_ITEM, refreshToken);
    },

    clearPendingRevocation() {
      return store.deleteItemAsync(PENDING_REVOCATION_ITEM);
    },
  };
}

/** The cloud a session belongs to. Kept after sign-out, to finish a revocation. */
export interface SessionCloud {
  readonly baseUrl: string;
  readonly auth: DeviceAuthConfig;
}

export async function loadSessionCloud(store: SecureStore): Promise<SessionCloud | null> {
  const stored = await store.getItemAsync(CLOUD_ITEM);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as { baseUrl?: unknown; auth?: unknown };
    const auth = parseDeviceAuthConfig(parsed.auth);
    if (typeof parsed.baseUrl !== "string" || !auth) return null;
    return { baseUrl: parsed.baseUrl, auth };
  } catch {
    return null;
  }
}

/** This phone's signed-in session, or null. Never touches the network. */
export async function loadSignedIn(
  store: SecureStore,
): Promise<{ readonly cloud: SessionCloud; readonly email: string | null } | null> {
  const session = await createSessionStore(store).read();
  if (!session) return null;
  const cloud = await loadSessionCloud(store);
  return cloud ? { cloud, email: session.email } : null;
}

/** A Cognito client for a cloud's device client. */
export function cognitoFor(cloud: SessionCloud, fetchImpl?: typeof fetch): CognitoClient {
  return createCognitoClient({
    region: cloud.auth.region,
    userPoolClientId: cloud.auth.deviceClientId,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

/**
 * Check a typed cloud address, and normalize it. Refuses plain http except to
 * a development machine, because the password and the photos go to it.
 */
export function checkCloudAddress(address: string): { ok: true; baseUrl: string } | { ok: false; reason: string } {
  const trimmed = address.trim().replace(/\/+$/, "");
  const m = trimmed.match(/^(https?):\/\/([A-Za-z0-9.-]+)(:\d{1,5})?(\/[^\s]*)?$/);
  if (!m) return { ok: false, reason: "Enter the cloud address your admin sent, starting with https://." };
  if (m[1] === "http" && !PLAIN_HTTP_HOSTS.has(m[2]!.toLowerCase())) {
    return { ok: false, reason: "The cloud address must use https." };
  }
  return { ok: true, baseUrl: trimmed };
}

/** Thrown when an account signs in on a phone whose library belongs to another account. */
export class LibraryBelongsElsewhereError extends Error {
  constructor() {
    super(
      "This phone's library belongs to another account. Sign in as that account, or reset this phone's library first.",
    );
    this.name = "LibraryBelongsElsewhereError";
  }
}

/**
 * Listeners told when the pool ends this phone's sign-in mid-run: an admin
 * signed the person out everywhere, disabled the account, or the refresh token
 * expired. The session is already cleared when they hear of it.
 */
const rejectionListeners = new Set<(reason: string) => void>();

/** Hear when the pool ends this phone's sign-in. Returns the unsubscribe. */
export function onSessionRejected(listener: (reason: string) => void): () => void {
  rejectionListeners.add(listener);
  return () => rejectionListeners.delete(listener);
}

/** For the token source's `onRejected`. */
export function notifySessionRejected(reason: string): void {
  for (const listener of rejectionListeners) listener(reason);
}

export type SignInOutcome =
  | { readonly kind: "signed-in"; readonly email: string | null; readonly userId: string }
  | { readonly kind: "new-password-required" };

/**
 * Sign this phone in to the cloud at `baseUrl`.
 *
 * Stateless across the new-password step, as the local data server's route
 * is: an account's first sign-in answers `new-password-required`, and the
 * screen calls again with the temporary password and the new one.
 *
 * Throws Cognito's own error for a wrong password or a password the policy
 * refuses, the cloud's for an address that is not a Starkeep cloud, and
 * {@link LibraryBelongsElsewhereError} for an account other than the library's.
 */
export async function signInPhone(
  store: SecureStore,
  args: {
    baseUrl: string;
    email: string;
    password: string;
    newPassword?: string;
    /** The user this phone's library belongs to, or null while it belongs to nobody. */
    libraryOwner?: string | null;
  },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<SignInOutcome> {
  const auth = await fetchDeviceAuthConfig(args.baseUrl, fetchImpl);
  const cloud: SessionCloud = { baseUrl: args.baseUrl, auth };
  const client = cognitoFor(cloud, fetchImpl);
  const result = await client.signIn(args.email, args.password);
  let tokens: AuthTokens;
  if (result.kind === "new-password-required") {
    if (!args.newPassword) return { kind: "new-password-required" };
    tokens = await client.setNewPassword(args.email, result.session, args.newPassword);
  } else {
    tokens = result.tokens;
  }
  const userId = idTokenClaims(tokens.idToken).sub;
  if (!userId) throw new Error("The cloud's sign-in named no user.");
  // A library already bound to another person stays theirs. Refused before
  // anything is stored, and the new sign-in is ended at the pool, as the local
  // data server does.
  if (args.libraryOwner && args.libraryOwner !== userId) {
    await client.revoke(tokens.refreshToken).catch(() => undefined);
    throw new LibraryBelongsElsewhereError();
  }

  const sessions = createSessionStore(store);
  // A previous sign-in on this phone is replaced, and ended at its pool.
  const previous = await sessions.read();
  const previousCloud = await loadSessionCloud(store);
  if (previous && previousCloud) {
    await sessions.writePendingRevocation(previous.refreshToken);
    void revokePendingSignOut(cognitoFor(previousCloud, fetchImpl), sessions).catch(() => undefined);
  }
  await store.setItemAsync(CLOUD_ITEM, JSON.stringify(cloud));
  const session = await storeSignIn(sessions, tokens);
  return { kind: "signed-in", email: session.email ?? args.email, userId };
}

/**
 * Sign this phone out: locally at once, and at the pool as soon as it answers.
 * The phone's library stays; it stops syncing.
 */
export async function signOutPhone(store: SecureStore, fetchImpl?: typeof fetch): Promise<RevocationOutcome> {
  const sessions = createSessionStore(store);
  const session = await sessions.read();
  const cloud = await loadSessionCloud(store);
  if (!session) return "none";
  if (!cloud) {
    await sessions.clear();
    return "none";
  }
  return signOut(cognitoFor(cloud, fetchImpl), sessions, session);
}

/** Finish a sign-out that could not reach the pool. Run at launch. */
export async function finishPendingSignOut(store: SecureStore, fetchImpl?: typeof fetch): Promise<RevocationOutcome> {
  const cloud = await loadSessionCloud(store);
  if (!cloud) return "none";
  return revokePendingSignOut(cognitoFor(cloud, fetchImpl), createSessionStore(store));
}
