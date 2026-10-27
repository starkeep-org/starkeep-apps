/**
 * This phone's sign-in: the person's Starkeep account, through the pool's
 * mobile-apps client, on the cloud's managed login page.
 *
 * ## What a sign-in is
 *
 * The person types the cloud's address; the phone opens the managed login page
 * in the system browser (`browser-sign-in.ts`), and the page takes the
 * password. The phone never sees it. The phone then registers an attested
 * Keystore key (`attested-key.ts`), and syncs with the ID token plus that key's
 * signature on every request. The cloud resolves the app from the key and lets
 * it reach Photos' types alone. The identity pool does not trust the
 * mobile-apps client, so the token reaches no AWS role.
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
 * A sign-out that has not reached the pool yet is kept as one more item, with
 * the pool that issued the token, so a phone signed out in a tunnel revokes
 * its token at the next launch or sign-in, at the right pool.
 */

import {
  createCognitoClient,
  DATA_GROUP,
  endReplacedSession,
  fetchMobileAuthConfig,
  idTokenClaims,
  parseMobileAuthConfig,
  revokePendingSignOut,
  signOut,
  storeSignIn,
  type CognitoClient,
  type CognitoClientFor,
  type MobileAuthConfig,
  type RevocationOutcome,
  type SessionStore,
} from "@starkeep/protocol-primitives";
import {
  forgetAttestedKey,
  registerAttestedKey,
  storeKeyId,
  type AttestedKeyNative,
  type Sha256,
} from "./attested-key";
import { signInWithBrowser, type BrowserSignInDeps } from "./browser-sign-in";

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

export function createSessionStore(store: SecureStore): SessionStore<MobileAuthConfig> {
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

    async readPendingRevocation() {
      const stored = await store.getItemAsync(PENDING_REVOCATION_ITEM);
      if (!stored) return null;
      try {
        const parsed = JSON.parse(stored) as { refreshToken?: unknown; auth?: unknown };
        const auth = parseMobileAuthConfig(parsed.auth);
        return typeof parsed.refreshToken === "string" && auth ? { refreshToken: parsed.refreshToken, auth } : null;
      } catch {
        return null;
      }
    },

    writePendingRevocation(pending) {
      return store.setItemAsync(PENDING_REVOCATION_ITEM, JSON.stringify(pending));
    },

    clearPendingRevocation() {
      return store.deleteItemAsync(PENDING_REVOCATION_ITEM);
    },
  };
}

/** The cloud a session belongs to. Kept after sign-out, to finish a revocation. */
export interface SessionCloud {
  readonly baseUrl: string;
  readonly auth: MobileAuthConfig;
}

export async function loadSessionCloud(store: SecureStore): Promise<SessionCloud | null> {
  const stored = await store.getItemAsync(CLOUD_ITEM);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as { baseUrl?: unknown; auth?: unknown };
    const auth = parseMobileAuthConfig(parsed.auth);
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

/** A Cognito client for a cloud's mobile-apps client. */
export function cognitoFor(cloud: SessionCloud, fetchImpl?: typeof fetch): CognitoClient {
  return clientsFor(fetchImpl)(cloud.auth);
}

/** Cognito clients for any pool, over one `fetch`. */
function clientsFor(fetchImpl?: typeof fetch): CognitoClientFor<MobileAuthConfig> {
  return (auth: MobileAuthConfig) =>
    createCognitoClient({
      region: auth.region,
      userPoolClientId: auth.mobileClientId,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
}

/**
 * Check a typed cloud address, and normalize it. Refuses plain http except to
 * a development machine, because the session and the photos go to it.
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

/** Thrown when an account with no data library, such as an admin-only one, signs in. */
export class NoDataLibraryError extends Error {
  constructor() {
    super("This account has no library to sync. Ask your admin to give it one.");
    this.name = "NoDataLibraryError";
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

export interface SignInOutcome {
  readonly email: string | null;
  readonly userId: string;
}

/** What a sign-in reaches outside this module: the browser, the Keystore and the network. */
export interface PhoneSignInDeps extends Omit<BrowserSignInDeps, "fetch"> {
  readonly attestedKey: AttestedKeyNative | null;
  readonly sha256: Sha256;
  readonly fetch?: typeof fetch;
}

/**
 * Sign this phone in to the cloud at `baseUrl`, on the cloud's managed login
 * page, and register this app's attested key.
 *
 * Throws `SignInCancelledError` when the person closes the page, the page's
 * own reason when it refuses, the cloud's for an address that is not a
 * Starkeep cloud, {@link NoDataLibraryError} for an account that can never
 * sync, {@link LibraryBelongsElsewhereError} for an account other than the
 * library's, and `AttestationRefusedError` when the cloud cannot confirm the
 * app. Nothing is kept on any refusal, and a session the page granted is
 * ended at the pool.
 */
export async function signInPhone(
  store: SecureStore,
  args: {
    baseUrl: string;
    /** The user this phone's library belongs to, or null while it belongs to nobody. */
    libraryOwner?: string | null;
  },
  deps: PhoneSignInDeps,
): Promise<SignInOutcome> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const auth = await fetchMobileAuthConfig(args.baseUrl, fetchImpl);
  const cloud: SessionCloud = { baseUrl: args.baseUrl, auth };
  const client = cognitoFor(cloud, fetchImpl);
  const tokens = await signInWithBrowser(auth, { ...deps, fetch: fetchImpl });
  const claims = idTokenClaims(tokens.idToken);
  const userId = claims.sub;
  if (!userId) throw new Error("The cloud's sign-in named no user.");
  // The cloud refuses a token without the data group, so the account could
  // never sync. Refused before it is kept, as the local data server does.
  if (!claims.groups.includes(DATA_GROUP)) {
    await client.revoke(tokens.refreshToken).catch(() => undefined);
    throw new NoDataLibraryError();
  }
  // A library already bound to another person stays theirs. Refused before
  // anything is stored, and the new sign-in is ended at the pool, as the local
  // data server does.
  if (args.libraryOwner && args.libraryOwner !== userId) {
    await client.revoke(tokens.refreshToken).catch(() => undefined);
    throw new LibraryBelongsElsewhereError();
  }
  // The key comes before the session is kept: a phone the cloud will not
  // trust to speak for Photos cannot sync, so it is not signed in either.
  let keyId: string;
  try {
    ({ keyId } = await registerAttestedKey({
      baseUrl: args.baseUrl,
      idToken: tokens.idToken,
      native: deps.attestedKey,
      sha256: deps.sha256,
      fetch: fetchImpl,
    }));
  } catch (err) {
    await client.revoke(tokens.refreshToken).catch(() => undefined);
    throw err;
  }

  const sessions = createSessionStore(store);
  // A sign-out still waiting on its pool finishes now, and a previous sign-in
  // on this phone is replaced and ended at its own pool.
  const previousCloud = await loadSessionCloud(store);
  await endReplacedSession(clientsFor(fetchImpl), sessions, previousCloud?.auth ?? null);
  await store.setItemAsync(CLOUD_ITEM, JSON.stringify(cloud));
  const session = await storeSignIn(sessions, tokens);
  await storeKeyId(store, keyId);
  return { email: session.email, userId };
}

/**
 * Sign this phone out: locally at once, and at the pool as soon as it answers.
 * The phone's library stays; it stops syncing.
 */
export async function signOutPhone(
  store: SecureStore,
  attestedKey: AttestedKeyNative | null,
  fetchImpl?: typeof fetch,
): Promise<RevocationOutcome> {
  // The key goes first: it is worthless without a live token, but a phone
  // signed out should hold nothing that speaks for it.
  await forgetAttestedKey(store, attestedKey);
  const sessions = createSessionStore(store);
  const session = await sessions.read();
  const cloud = await loadSessionCloud(store);
  if (!session) return "none";
  if (!cloud) {
    await sessions.clear();
    return "none";
  }
  return signOut(clientsFor(fetchImpl), sessions, session, cloud.auth);
}

/** Finish a sign-out that could not reach its pool. Run at launch. */
export function finishPendingSignOut(store: SecureStore, fetchImpl?: typeof fetch): Promise<RevocationOutcome> {
  return revokePendingSignOut(clientsFor(fetchImpl), createSessionStore(store));
}
