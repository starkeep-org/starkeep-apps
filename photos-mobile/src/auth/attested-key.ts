/**
 * This phone's attested key: the proof the cloud reads to learn which app is
 * syncing.
 *
 * The phone signs in through the cloud's public mobile-apps client, so a token
 * says who the person is but not which app holds it. After each sign-in the
 * phone makes a fresh Keystore key, attested with SHA-256 of the new ID token,
 * and registers it with the cloud. The cloud checks the chain against Google's
 * roots, finds the app whose manifest declared this package and signing
 * certificate, and answers with the key's id. Every data-plane request then
 * carries a signature by the key, and the cloud lets it reach Photos' types
 * and nothing else.
 *
 * The native half is `modules/starkeep-attested-key`; everything here takes it
 * as a parameter, so it runs under Vitest.
 */

import { MOBILE_KEYS_ROUTE, USER_TOKEN_HEADER, type MobileRequestSigner } from "@starkeep/protocol-primitives";
import type { SecureStore } from "./session";

/** The Keystore alias. One key per install; each sign-in replaces it. */
export const ATTESTED_KEY_ALIAS = "starkeep.sync.attested-key";
/** The registered key's id, in the secure store. */
const KEY_ID_ITEM = "starkeep.session.keyId";

/** The native module's calls, as `modules/starkeep-attested-key/index.ts` declares them. */
export interface AttestedKeyNative {
  generate(alias: string, challengeBase64: string): Promise<string[]>;
  signDigest(alias: string, digestBase64: string): Promise<string>;
  remove(alias: string): Promise<void>;
}

export type Sha256 = (bytes: Uint8Array) => Promise<Uint8Array>;

/** The cloud refused this phone's attestation. The message is the cloud's reason. */
export class AttestationRefusedError extends Error {
  constructor(reason: string) {
    super(`The cloud could not confirm this is Starkeep Photos: ${reason}`);
    this.name = "AttestationRefusedError";
  }
}

/** The binary has no Keystore module: a development client built before it existed. */
export class NoKeystoreModuleError extends Error {
  constructor() {
    super("This build cannot prove which app it is. Install the current build to sync.");
    this.name = "NoKeystoreModuleError";
  }
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding. By hand, as `idTokenClaims` decodes, so it does not depend on Hermes' `btoa`. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += BASE64[a >> 2];
    out += BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : BASE64[c & 63];
  }
  return out;
}

/**
 * Make a fresh attested key for `idToken`'s sign-in and register it with the
 * cloud. Resolves with the key's id and the app the cloud attested it to; the
 * caller keeps the id with {@link storeKeyId} once the sign-in is kept.
 */
export async function registerAttestedKey(args: {
  baseUrl: string;
  idToken: string;
  native: AttestedKeyNative | null;
  sha256: Sha256;
  fetch: typeof fetch;
}): Promise<{ keyId: string; appId: string }> {
  if (!args.native) throw new NoKeystoreModuleError();
  const challenge = await args.sha256(new TextEncoder().encode(args.idToken));
  const chain = await args.native.generate(ATTESTED_KEY_ALIAS, toBase64(challenge));
  const res = await args.fetch(`${args.baseUrl.replace(/\/+$/, "")}/apps/starkeep-drive${MOBILE_KEYS_ROUTE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [USER_TOKEN_HEADER]: args.idToken },
    body: JSON.stringify({ chain }),
  });
  const body = (await res.json().catch(() => ({}))) as { keyId?: unknown; appId?: unknown; error?: unknown };
  if (!res.ok || typeof body.keyId !== "string" || typeof body.appId !== "string") {
    await args.native.remove(ATTESTED_KEY_ALIAS).catch(() => undefined);
    throw new AttestationRefusedError(typeof body.error === "string" ? body.error : `the cloud answered ${res.status}`);
  }
  return { keyId: body.keyId, appId: body.appId };
}

export function storeKeyId(store: SecureStore, keyId: string): Promise<void> {
  return store.setItemAsync(KEY_ID_ITEM, keyId);
}

/** Forget the key, here and in the Keystore. At sign-out. */
export async function forgetAttestedKey(store: SecureStore, native: AttestedKeyNative | null): Promise<void> {
  await store.deleteItemAsync(KEY_ID_ITEM);
  await native?.remove(ATTESTED_KEY_ALIAS).catch(() => undefined);
}

/**
 * What signs the Drive channel's requests: the stored key id, and a signature
 * by the Keystore key over SHA-256 of the message. The digest is taken by
 * expo-crypto's native SHA-256, so the body crosses into native code once and
 * the signing call carries 32 bytes.
 */
export function createRequestSigner(
  store: SecureStore,
  native: AttestedKeyNative | null,
  sha256: Sha256,
): MobileRequestSigner {
  return {
    keyId: () => store.getItemAsync(KEY_ID_ITEM),
    async sign(message) {
      if (!native) throw new NoKeystoreModuleError();
      return native.signDigest(ATTESTED_KEY_ALIAS, toBase64(await sha256(message)));
    },
  };
}
