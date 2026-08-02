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
 * against a registered public key. The private half never leaves the device and
 * the cloud stores nothing secret, which means a lost phone is one deleted SSM
 * parameter and nothing else in the system notices.
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

const PRIVATE_KEY_ITEM = "starkeep.device.privateKey";

export interface DeviceKey {
  /** Names this device to the cloud. Travels in `X-Starkeep-Device-Id`. */
  readonly deviceId: string;
  /** Base64 SPKI — what gets registered. Not secret. */
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

export interface LoadDeviceKeyOptions {
  readonly store: SecureStore;
  /** This device's node id — reused so a device has one name, not two. */
  readonly deviceId: string;
  /** Injected so tests are deterministic; the platform passes a real CSPRNG. */
  readonly randomBytes: (length: number) => Uint8Array;
}

/**
 * Load this device's key, generating one on first use.
 *
 * The device id is the node id rather than a new identifier. A device with two
 * names is a device whose sync history and whose credential cannot be
 * correlated by anyone reading a log or a residency inspector, and there is no
 * reason for them to differ.
 */
export async function loadDeviceKey(options: LoadDeviceKeyOptions): Promise<DeviceKey> {
  const stored = await options.store.getItemAsync(PRIVATE_KEY_ITEM);

  let privateKey: Uint8Array;
  if (stored) {
    privateKey = fromBase64(stored);
  } else {
    privateKey = options.randomBytes(32);
    await options.store.setItemAsync(PRIVATE_KEY_ITEM, toBase64(privateKey));
  }

  const publicKey = ed25519.getPublicKey(privateKey);

  return {
    deviceId: options.deviceId,
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
        [DEVICE_ID_HEADER]: options.deviceId,
        [DEVICE_SIG_HEADER]: toBase64(ed25519.sign(message, privateKey)),
      };
    },
  };
}

/** Forget this device's key. Pairing again mints a new one. */
export async function clearDeviceKey(store: SecureStore): Promise<void> {
  await store.deleteItemAsync(PRIVATE_KEY_ITEM);
}
