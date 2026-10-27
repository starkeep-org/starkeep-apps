/**
 * The attested key's plumbing that runs without a handset: base64, and the
 * signer the Drive channel signs with.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ATTESTED_KEY_ALIAS, createRequestSigner, storeKeyId, toBase64 } from "../src/auth/attested-key";
import { fakeSecureStore } from "./helpers/fake-secure-store";

describe("toBase64", () => {
  it("matches Node's encoding at every padding length", () => {
    for (const text of ["", "a", "ab", "abc", "abcd", "ÿþ\u0000"]) {
      const bytes = new TextEncoder().encode(text);
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });
});

describe("createRequestSigner", () => {
  it("signs SHA-256 of the message with the Keystore key, and names the stored key", async () => {
    const { store } = fakeSecureStore();
    await storeKeyId(store, "k".repeat(64));
    const asked: Array<{ alias: string; digest: string }> = [];
    const signer = createRequestSigner(
      store,
      {
        generate: async () => [],
        signDigest: async (alias, digest) => {
          asked.push({ alias, digest });
          return "c2ln";
        },
        remove: async () => undefined,
      },
      async (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest()),
    );

    const message = new TextEncoder().encode("starkeep-drive:POST:/sync/exchange:1:{}");
    expect(await signer.keyId()).toBe("k".repeat(64));
    expect(await signer.sign(message)).toBe("c2ln");
    // Only the 32-byte digest crosses into the native call.
    expect(asked).toEqual([
      { alias: ATTESTED_KEY_ALIAS, digest: createHash("sha256").update(message).digest("base64") },
    ]);
  });

  it("has no key to name before a sign-in registers one", async () => {
    const signer = createRequestSigner(fakeSecureStore().store, null, async () => new Uint8Array(32));
    expect(await signer.keyId()).toBeNull();
    await expect(signer.sign(new Uint8Array(1))).rejects.toThrow(/cannot prove which app/);
  });
});
