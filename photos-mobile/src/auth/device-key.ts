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
 * Admin-web makes it. Pairing is this phone's install step: the operator names
 * the phone in admin-web, admin-web generates the keypair in the browser,
 * registers the public half, and shows the private half once as a QR code. The
 * phone scans the code ({@link parsePairingPayload}) and keeps the result in
 * the secure store. The code also carries the cloud's URL, so the phone learns
 * which Starkeep it belongs to from the code rather than from its build.
 *
 * A phone that made its own key would have to deliver the public half to the
 * cloud before it could authenticate anything, which needs an unauthenticated
 * route and a credential write in the cloud's request path. See
 * `~/projects/starkeep/plan-mobile-qr-pairing-2026-10-13.md`.
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

import { ed25519 } from "@noble/curves/ed25519.js";

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

/** Must match the cloud's `isValidDeviceId`; the id becomes an SSM parameter name. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Must match the settings file's `MAX_DEVICE_LABEL_LENGTH`. */
const MAX_LABEL_LENGTH = 100;

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

export const APP_ID_HEADER = "X-Starkeep-App-Id";
export const APP_TS_HEADER = "X-Starkeep-App-Ts";
export const DEVICE_ID_HEADER = "X-Starkeep-Device-Id";
export const DEVICE_SIG_HEADER = "X-Starkeep-Device-Sig";

/**
 * The canonical path, copied from `@starkeep/app-client`'s `sign.ts`.
 *
 * Copied rather than imported because that package is Node-only — it imports
 * `node:crypto` at module scope. The rule is four lines and is asserted against
 * the same cases on both sides; importing it would make this module unloadable
 * on a handset, which is the failure that has already been paid for twice here.
 */
export function canonicalSignedPath(path: string): string {
  const q = path.indexOf("?");
  const pathname = q >= 0 ? path.slice(0, q) : path;
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/** The exact bytes both primitives sign. */
export function signedMessage(
  appId: string,
  method: string,
  path: string,
  ts: number,
  body: Uint8Array | undefined,
): Uint8Array {
  const prefix = new TextEncoder().encode(
    `${appId}:${method.toUpperCase()}:${canonicalSignedPath(path)}:${ts}:`,
  );
  if (!body || body.byteLength === 0) return prefix;
  const out = new Uint8Array(prefix.byteLength + body.byteLength);
  out.set(prefix, 0);
  out.set(body, prefix.byteLength);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // `btoa` exists on Hermes and in Node 16+. Chunking is unnecessary at these
  // sizes — a key is 32 bytes and a signature 64.
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The 12-byte SPKI prefix for an Ed25519 public key (RFC 8410).
 *
 * Emitted so the cloud can `createPublicKey({ type: "spki", format: "der" })`
 * directly — Node has no "raw Ed25519 bytes" import, and asking the verifier to
 * hand-assemble this would put the same twelve magic bytes in two places.
 */
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

function spkiFrom(rawPublicKey: Uint8Array): Uint8Array {
  const out = new Uint8Array(ED25519_SPKI_PREFIX.byteLength + rawPublicKey.byteLength);
  out.set(ED25519_SPKI_PREFIX, 0);
  out.set(rawPublicKey, ED25519_SPKI_PREFIX.byteLength);
  return out;
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
  if (label !== undefined && label !== null && (typeof label !== "string" || label.length > MAX_LABEL_LENGTH)) {
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
  const privateKey = fromBase64(credential.privateKey);
  const publicKey = ed25519.getPublicKey(privateKey);

  return {
    deviceId: credential.deviceId,
    label: credential.label,
    baseUrl: credential.baseUrl,
    publicKeySpki: toBase64(spkiFrom(publicKey)),
    signRequest(appId, method, path, body) {
      const ts = Date.now();
      // GET and HEAD sign an empty body, matching the verifier — which cannot
      // see a body on those methods and so signs `Buffer.alloc(0)`.
      const upper = method.toUpperCase();
      const signedBody = upper === "GET" || upper === "HEAD" ? undefined : body;
      const message = signedMessage(appId, upper, path, ts, signedBody);
      return {
        [APP_ID_HEADER]: appId,
        [APP_TS_HEADER]: String(ts),
        [DEVICE_ID_HEADER]: credential.deviceId,
        [DEVICE_SIG_HEADER]: toBase64(ed25519.sign(message, privateKey)),
      };
    },
  };
}
