/**
 * This device's signing key — how the phone proves itself to the cloud.
 *
 * ## What it replaces, and why not the obvious thing
 *
 * The cloud data plane authenticates *applications*, by HMAC against a per-app
 * secret held in SSM. The obvious way to let a handset in is to give it that
 * secret, and it must not be done: the secret is symmetric, so a handset
 * holding it **is** the app; it is extractable, because an APK is distributable
 * and a rooted device reads whatever the app can read; it never expires; and
 * revoking it after a lost phone breaks the laptop and the app's own cloud
 * Lambda too. Every cost of that shortcut lands later, on someone else.
 *
 * So the phone gets its own **asymmetric** key. It signs; the cloud verifies
 * against a registered public key, and the cloud stores nothing secret, which
 * means a lost phone is one deleted SSM parameter and nothing else in the system
 * notices.
 *
 * ## Where the key comes from
 *
 * Two ways, and the cloud's request path writes no credential in either.
 *
 * - **Admin-web makes it.** The operator names the phone in admin-web, which
 *   generates the keypair in the browser, registers the public half, and shows
 *   the private half once as a QR code. The phone scans the code
 *   ({@link parsePairingPayload}) and keeps the result in the secure store. The
 *   code also carries the cloud's URL. See
 *   `~/projects/starkeep/plan-mobile-qr-pairing-2026-10-13.md`.
 * - **The phone makes it.** The person types the cloud's address, and the
 *   phone generates the keypair and shows a pairing code holding only the
 *   public half ({@link startCodePairing}). An admin approves the code in
 *   admin-web, and the phone learns of it by polling `device/self`
 *   ({@link checkCodePairing}). The private half never leaves the phone.
 *
 * The signing itself is protocol-primitives' `deviceSigner`, the same code the
 * local data server signs with.
 *
 * ## The signed message is not ours to invent
 *
 * It is byte-identical to what the HMAC scheme already signs —
 * `${appId}:${METHOD}:${path}:${ts}:` ++ body — so the method binding, the path
 * binding, the replay window and the canonical-path rule are inherited rather
 * than reimplemented. Only the primitive differs. A second canonicalisation is
 * exactly how two implementations come to disagree about what was signed, and
 * the disagreement shows up as "401 on one route" long after the change that
 * caused it.
 *
 * ## What this is not
 *
 * Hardware-backed. `expo-secure-store` is Keystore-*encrypted*, not
 * Keystore-*generated*, so a rooted device can extract the key. That is a
 * strict upgrade available later — a native module doing Keystore-generated EC
 * keys — and nothing above this file changes when it lands. What is already
 * true, and matters more, is that the credential is **per-device and
 * individually revocable**.
 */

import {
  APP_ID_HEADER,
  APP_TS_HEADER,
  canonicalSignedPath,
  DEVICE_ID_HEADER,
  DEVICE_ID_PATTERN,
  DEVICE_SELF_ROUTE,
  DEVICE_SIG_HEADER,
  deviceFingerprint,
  deviceSigner,
  encodePairingRequest,
  fromBase64,
  generateDeviceId,
  generateDeviceSeed,
  MAX_DEVICE_LABEL_LENGTH,
  signedMessage,
  toBase64,
  type RandomBytes,
} from "@starkeep/protocol-primitives";

export {
  APP_ID_HEADER,
  APP_TS_HEADER,
  canonicalSignedPath,
  DEVICE_ID_HEADER,
  DEVICE_SIG_HEADER,
  signedMessage,
};

/** Where the private key lives. Supplied at the edge; see `platform.ts`. */
export interface SecureStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** Where the scanned credential lives: one item, so it is stored or absent whole. */
const CREDENTIAL_ITEM = "starkeep.device.credential";

/**
 * Where a self-generated key lived before QR pairing. Never read; deleted on
 * disconnect so a phone holds no stale key.
 */
const LEGACY_PRIVATE_KEY_ITEM = "starkeep.device.privateKey";

/** The version of the QR payload this build reads. */
export const PAIRING_PAYLOAD_VERSION = 1;

/** Where a key this phone made waits until an admin approves it. */
const PENDING_ITEM = "starkeep.device.pending";

/**
 * Hosts a development cloud answers on without TLS: the machine itself, and the
 * Android emulator's alias for the machine running it.
 */
const PLAIN_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

/** What a scanned pairing code gives this phone. */
export interface DeviceCredential {
  readonly deviceId: string;
  /** Base64 of the 32-byte Ed25519 seed. */
  readonly privateKey: string;
  /** The cloud this phone syncs with. */
  readonly baseUrl: string;
  /** What the operator called this phone in admin-web, or null. */
  readonly label: string | null;
}

export interface DeviceKey {
  /** Names this device to the cloud. Travels in `X-Starkeep-Device-Id`. */
  readonly deviceId: string;
  /** What the operator called this phone, so the phone can name itself the same way. */
  readonly label: string | null;
  /** The cloud this phone syncs with. */
  readonly baseUrl: string;
  /** Base64 SPKI of the public half. Not secret; admin-web registered it. */
  readonly publicKeySpki: string;
  /**
   * Headers authenticating one request.
   *
   * `body` must be exactly the bytes that will be sent. The cloud verifies
   * against what it received, so a body serialized twice — once to sign, once
   * to send — is a 401 whenever the two differ by a byte.
   */
  signRequest(
    appId: string,
    method: string,
    path: string,
    body: Uint8Array | undefined,
  ): Record<string, string>;
}

export type PairingParse =
  | { readonly ok: true; readonly credential: DeviceCredential; readonly host: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Read a scanned QR code.
 *
 * Anything a camera can see reaches this, so it trusts nothing. The result also
 * names the host the code points at: the screen shows it and asks before
 * connecting, because a code from anywhere but the owner's admin-web would send
 * this phone's photos to someone else's server.
 */
export function parsePairingPayload(text: string): PairingParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "That is not a Starkeep pairing code." };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "That is not a Starkeep pairing code." };
  }
  const v = value as Record<string, unknown>;
  if (v["starkeepPair"] === undefined) {
    return { ok: false, reason: "That is not a Starkeep pairing code." };
  }
  if (v["starkeepPair"] !== PAIRING_PAYLOAD_VERSION) {
    return {
      ok: false,
      reason: "This pairing code is from a different version of admin-web. Update the app, then scan again.",
    };
  }

  const deviceId = v["deviceId"];
  if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) {
    return { ok: false, reason: "The pairing code's device id is not valid." };
  }

  const privateKey = v["privateKey"];
  let seed: Uint8Array | null = null;
  if (typeof privateKey === "string") {
    try {
      seed = fromBase64(privateKey);
    } catch {
      seed = null;
    }
  }
  if (!seed || seed.length !== 32) {
    return { ok: false, reason: "The pairing code's key is not valid." };
  }

  const baseUrl = v["baseUrl"];
  const host = typeof baseUrl === "string" ? hostOf(baseUrl) : null;
  if (typeof baseUrl !== "string" || host === null) {
    return { ok: false, reason: "The pairing code's cloud address is not valid." };
  }
  if (baseUrl.startsWith("http://") && !PLAIN_HTTP_HOSTS.has(host)) {
    return { ok: false, reason: "The pairing code's cloud address must use https." };
  }

  const label = v["label"];
  if (label !== undefined && label !== null && (typeof label !== "string" || label.length > MAX_DEVICE_LABEL_LENGTH)) {
    return { ok: false, reason: "The pairing code's device name is not valid." };
  }

  return {
    ok: true,
    host,
    credential: {
      deviceId,
      privateKey,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      label: typeof label === "string" ? label : null,
    } as DeviceCredential,
  };
}

/**
 * The host of an http(s) URL, or null.
 *
 * Parsed by hand rather than with `URL`, whose React Native implementation does
 * not expose every field the web one does.
 */
function hostOf(url: string): string | null {
  const m = url.match(/^https?:\/\/([A-Za-z0-9.-]+)(:\d{1,5})?(\/[^\s]*)?$/);
  return m ? m[1]!.toLowerCase() : null;
}

/** Keep a scanned credential. Replaces any earlier one. */
export async function storeDeviceCredential(store: SecureStore, credential: DeviceCredential): Promise<void> {
  await store.setItemAsync(CREDENTIAL_ITEM, JSON.stringify(credential));
}

/**
 * Forget this phone's credential. The phone stops syncing at once; the key
 * stays valid in the cloud until the operator revokes it in admin-web.
 */
export async function clearDeviceCredential(store: SecureStore): Promise<void> {
  await store.deleteItemAsync(CREDENTIAL_ITEM);
  await store.deleteItemAsync(LEGACY_PRIVATE_KEY_ITEM);
}

/**
 * This phone's key, or null when the phone is not paired.
 *
 * A stored credential that no longer parses counts as unpaired. That can only
 * happen to a credential written by a different build, and pairing again is
 * the fix either way.
 */
export async function loadDeviceKey(store: SecureStore): Promise<DeviceKey | null> {
  const stored = await store.getItemAsync(CREDENTIAL_ITEM);
  if (!stored) return null;
  let credential: DeviceCredential;
  try {
    const parsed = parsePairingPayload(
      JSON.stringify({ starkeepPair: PAIRING_PAYLOAD_VERSION, ...(JSON.parse(stored) as object) }),
    );
    if (!parsed.ok) return null;
    credential = parsed.credential;
  } catch {
    return null;
  }
  return keyFrom(credential);
}

/** A signer over a credential's seed. */
export function keyFrom(credential: DeviceCredential): DeviceKey {
  const signer = deviceSigner(credential.deviceId, fromBase64(credential.privateKey));
  return {
    deviceId: credential.deviceId,
    label: credential.label,
    baseUrl: credential.baseUrl,
    publicKeySpki: signer.publicKeySpki,
    signRequest: (appId, method, path, body) => signer.signRequest(appId, method, path, body),
  };
}

/** A key this phone made, waiting for an admin, and what the person shows the admin. */
export interface CodePairing {
  readonly credential: DeviceCredential;
  /** The pairing code: the public half, the id, the label and the kind. */
  readonly code: string;
  /** What the admin reads back to confirm the code came from this phone. */
  readonly fingerprint: string;
}

function codePairingFor(credential: DeviceCredential): CodePairing {
  const { publicKeySpki } = keyFrom(credential);
  return {
    credential,
    code: encodePairingRequest({
      deviceId: credential.deviceId,
      publicKeySpki,
      label: credential.label,
      kind: "phone",
    }),
    fingerprint: deviceFingerprint(publicKeySpki),
  };
}

/**
 * Make a key on this phone for the cloud at `baseUrl`, and keep it until an
 * admin approves it, so closing the app does not lose it. Replaces any earlier
 * key still waiting. Refuses an address the QR path would refuse.
 */
export async function startCodePairing(
  store: SecureStore,
  randomBytes: RandomBytes,
  baseUrl: string,
  label: string | null,
): Promise<CodePairing | { readonly ok: false; readonly reason: string }> {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const check = parsePairingPayload(
    JSON.stringify({
      starkeepPair: PAIRING_PAYLOAD_VERSION,
      deviceId: "dev_check",
      privateKey: toBase64(new Uint8Array(32)),
      baseUrl: trimmed,
      label,
    }),
  );
  if (!check.ok) return { ok: false, reason: check.reason.replace("The pairing code's", "The") };
  const credential: DeviceCredential = {
    deviceId: generateDeviceId(randomBytes),
    privateKey: toBase64(generateDeviceSeed(randomBytes)),
    baseUrl: trimmed,
    label,
  };
  await store.setItemAsync(PENDING_ITEM, JSON.stringify(credential));
  return codePairingFor(credential);
}

/** The key waiting for an admin, if any. */
export async function loadCodePairing(store: SecureStore): Promise<CodePairing | null> {
  const stored = await store.getItemAsync(PENDING_ITEM);
  if (!stored) return null;
  try {
    return codePairingFor(JSON.parse(stored) as DeviceCredential);
  } catch {
    return null;
  }
}

/** Forget the key waiting for an admin. */
export async function clearCodePairing(store: SecureStore): Promise<void> {
  await store.deleteItemAsync(PENDING_ITEM);
}

/**
 * Whether an admin has approved the waiting key: the cloud answers the
 * device's own record once it holds one, and 401 until then. Throws when the
 * cloud cannot be asked.
 */
export async function checkCodePairing(
  credential: DeviceCredential,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  const url = `${credential.baseUrl}/apps/starkeep-drive${DEVICE_SELF_ROUTE}`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: keyFrom(credential).signRequest("starkeep-drive", "GET", DEVICE_SELF_ROUTE, undefined),
  });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`the cloud answered ${res.status}`);
  return true;
}
