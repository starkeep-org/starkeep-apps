/**
 * The JavaScript face of {@link StarkeepAttestedKeyModule}: a Keystore signing
 * key the cloud trusts to speak for this app. Registering and using it is
 * `src/auth/attested-key.ts`, where it can be tested without a handset.
 */

import { requireOptionalNativeModule } from "expo";

export interface StarkeepAttestedKey {
  /**
   * Make a fresh EC P-256 key under `alias`, replacing any key there, attested
   * with `challengeBase64`. Resolves with the certificate chain, leaf first,
   * each certificate as base64 DER.
   */
  generate(alias: string, challengeBase64: string): Promise<string[]>;
  /** Sign a SHA-256 digest (base64) with the key. Resolves with a DER signature, base64. */
  signDigest(alias: string, digestBase64: string): Promise<string>;
  /** Delete the key. A no-op when there is none. */
  remove(alias: string): Promise<void>;
}

/**
 * Null when the native module is not in the binary: a development client built
 * before it existed. Sign-in then says the phone cannot prove which app it is,
 * rather than crashing at import.
 */
export default requireOptionalNativeModule<StarkeepAttestedKey>("StarkeepAttestedKey");
