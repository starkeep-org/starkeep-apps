/**
 * This device's identity as a node.
 *
 * ## Why it has to be durable
 *
 * The node id is stamped into every HLC timestamp this device generates, which
 * is how the protocol breaks ties between concurrent edits. A device that
 * invented a fresh id each launch would look like a new peer every time: its
 * old records would be attributed to a node nobody has heard from since, and
 * the tie-breaks between a record it wrote yesterday and one it writes today
 * would be decided by comparing two ids that are both, in truth, this phone.
 *
 * So this is written once, on first launch, and read forever after. Losing it
 * is not catastrophic — a new id is a new peer, and sync converges — but it is
 * silently wasteful, and the failure has no symptom anyone would notice.
 *
 * ## Deliberately not the credential
 *
 * This identifies the device to the *protocol*. It authenticates nothing, and
 * it must never be treated as though it did: it is stored in the app's private
 * document directory in plaintext, it is chosen by this device rather than
 * issued to it, and anything that trusted it would be trusting a string a
 * handset made up about itself.
 *
 * What authenticates this phone is the person's ID token and a signature by
 * the attested Keystore key on every data-plane request — see
 * `auth/session.ts` and `auth/attested-key.ts`. Neither one carries this id.
 */

import type { ExpoFileSystem } from "./storage/expo-object-storage";

export interface NodeIdentity {
  readonly nodeId: string;
  /** True the first time it was generated, so a caller can say so on screen. */
  readonly created: boolean;
}

/**
 * Read this device's node id, generating and persisting one if it has none.
 *
 * `generate` is injected rather than called directly because `generateId()`
 * reaches for a PRNG that Hermes only has once `react-native-get-random-values`
 * has run — see `index.ts`. Taking it as an argument keeps this module's tests
 * in Node and keeps the platform's initialisation order the platform's problem.
 */
export async function loadNodeIdentity(
  fs: ExpoFileSystem,
  path: string,
  generate: () => string,
): Promise<NodeIdentity> {
  const file = fs.file(path);
  if (file.exists) {
    try {
      const parsed = JSON.parse(await file.text()) as { nodeId?: unknown };
      if (typeof parsed.nodeId === "string" && parsed.nodeId.length > 0) {
        return { nodeId: parsed.nodeId, created: false };
      }
    } catch {
      // A truncated or half-written file is treated as no identity and
      // replaced, for the same reason the session store does it: a device that
      // cannot get past its own launch has no way to clear the file.
    }
  }

  const nodeId = generate();
  const fresh = fs.file(path);
  if (!fresh.exists) fresh.create({ intermediates: true, overwrite: false });
  fresh.write(JSON.stringify({ nodeId }));
  return { nodeId, created: true };
}
