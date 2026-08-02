/**
 * The device key, verified the way the cloud will verify it.
 *
 * The assertion this file exists for is cross-implementation: the phone signs
 * with `@noble/curves`, and the Lambda will verify with `node:crypto` against a
 * public key it read from SSM as a string. Those are two different Ed25519
 * implementations and two different key encodings, and "it signed something" is
 * not evidence that the other side can check it. So every signature here is
 * verified by `node:crypto`, from the SPKI the device actually publishes.
 *
 * The signing rules — canonical path, empty body on GET, the message layout —
 * are asserted against the same cases `@starkeep/app-client` uses, because they
 * are copied rather than imported (that package is Node-only) and a copy that
 * drifts is a 401 nobody can explain.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createPublicKey, verify as nodeVerify, createHmac } from "node:crypto";
import {
  loadDeviceKey,
  clearDeviceKey,
  signedMessage,
  canonicalSignedPath,
  APP_ID_HEADER,
  APP_TS_HEADER,
  DEVICE_ID_HEADER,
  DEVICE_SIG_HEADER,
  type DeviceKey,
  type SecureStore,
} from "../src/auth/device-key";

/** An in-memory expo-secure-store. */
function fakeSecureStore() {
  const items = new Map<string, string>();
  const store: SecureStore = {
    getItemAsync: async (k) => items.get(k) ?? null,
    setItemAsync: async (k, v) => void items.set(k, v),
    deleteItemAsync: async (k) => void items.delete(k),
  };
  return { store, items };
}

/** Deterministic "randomness", so a test can assert a stable key. */
const fixedRandom = (seed: number) => (length: number) =>
  new Uint8Array(Array.from({ length }, (_, i) => (i + seed) % 256));

/** Exactly what the cloud verifier will do. */
function cloudVerifies(
  publicKeySpki: string,
  message: Uint8Array,
  signatureBase64: string,
): boolean {
  const key = createPublicKey({
    key: Buffer.from(publicKeySpki, "base64"),
    type: "spki",
    format: "der",
  });
  return nodeVerify(null, message, key, Buffer.from(signatureBase64, "base64"));
}

let harness: ReturnType<typeof fakeSecureStore>;
let device: DeviceKey;

beforeEach(async () => {
  harness = fakeSecureStore();
  device = await loadDeviceKey({
    store: harness.store,
    deviceId: "node-abc",
    randomBytes: fixedRandom(1),
  });
});

describe("the key itself", () => {
  it("persists, so a restart is the same device", async () => {
    const again = await loadDeviceKey({
      store: harness.store,
      deviceId: "node-abc",
      // Different randomness — if this were used, the key would change.
      randomBytes: fixedRandom(99),
    });
    expect(again.publicKeySpki).toBe(device.publicKeySpki);
  });

  it("mints a new key once cleared", async () => {
    await clearDeviceKey(harness.store);
    const fresh = await loadDeviceKey({
      store: harness.store,
      deviceId: "node-abc",
      randomBytes: fixedRandom(99),
    });
    expect(fresh.publicKeySpki).not.toBe(device.publicKeySpki);
  });

  it("uses the node id as its device id, so a device has one name", () => {
    expect(device.deviceId).toBe("node-abc");
  });

  it("publishes a public key node:crypto can import directly", () => {
    // If the SPKI prefix were wrong this throws, and it would throw in the
    // Lambda rather than here — which is the whole point of asserting it.
    const key = createPublicKey({
      key: Buffer.from(device.publicKeySpki, "base64"),
      type: "spki",
      format: "der",
    });
    expect(key.asymmetricKeyType).toBe("ed25519");
  });

  it("never puts the private key anywhere but the secure store", () => {
    expect([...harness.items.keys()]).toEqual(["starkeep.device.privateKey"]);
    expect(device.publicKeySpki).not.toContain(harness.items.get("starkeep.device.privateKey"));
  });
});

describe("signatures the cloud will check", () => {
  const body = new TextEncoder().encode(JSON.stringify({ records: [{ id: "rec-1" }] }));

  it("verifies a POST with a body", () => {
    const headers = device.signRequest("starkeep-drive", "POST", "/sync/exchange", body);
    const message = signedMessage(
      "starkeep-drive",
      "POST",
      "/sync/exchange",
      Number(headers[APP_TS_HEADER]),
      body,
    );
    expect(cloudVerifies(device.publicKeySpki, message, headers[DEVICE_SIG_HEADER]!)).toBe(true);
  });

  it("verifies a GET, which signs an empty body", () => {
    // The verifier cannot see a body on GET and signs `Buffer.alloc(0)`. A
    // device that signed a body here would fail every GET, and only on a
    // device — the mismatch is invisible from either side alone.
    const headers = device.signRequest("starkeep-drive", "GET", "/sync/state", body);
    const message = signedMessage(
      "starkeep-drive",
      "GET",
      "/sync/state",
      Number(headers[APP_TS_HEADER]),
      undefined,
    );
    expect(cloudVerifies(device.publicKeySpki, message, headers[DEVICE_SIG_HEADER]!)).toBe(true);
  });

  it("does not verify against a different path", () => {
    const headers = device.signRequest("starkeep-drive", "POST", "/sync/exchange", body);
    const elsewhere = signedMessage(
      "starkeep-drive",
      "POST",
      "/data/records",
      Number(headers[APP_TS_HEADER]),
      body,
    );
    expect(cloudVerifies(device.publicKeySpki, elsewhere, headers[DEVICE_SIG_HEADER]!)).toBe(false);
  });

  it("does not verify against a different channel", () => {
    const headers = device.signRequest("starkeep-drive", "POST", "/sync/exchange", body);
    const other = signedMessage(
      "photos",
      "POST",
      "/sync/exchange",
      Number(headers[APP_TS_HEADER]),
      body,
    );
    expect(cloudVerifies(device.publicKeySpki, other, headers[DEVICE_SIG_HEADER]!)).toBe(false);
  });

  it("does not verify against a tampered body", () => {
    const headers = device.signRequest("starkeep-drive", "POST", "/sync/exchange", body);
    const tampered = signedMessage(
      "starkeep-drive",
      "POST",
      "/sync/exchange",
      Number(headers[APP_TS_HEADER]),
      new TextEncoder().encode("{}"),
    );
    expect(cloudVerifies(device.publicKeySpki, tampered, headers[DEVICE_SIG_HEADER]!)).toBe(false);
  });

  it("emits every header the verifier reads", () => {
    const headers = device.signRequest("starkeep-drive", "POST", "/sync/exchange", body);
    expect(Object.keys(headers).sort()).toEqual(
      [APP_ID_HEADER, APP_TS_HEADER, DEVICE_ID_HEADER, DEVICE_SIG_HEADER].sort(),
    );
    expect(headers[APP_ID_HEADER]).toBe("starkeep-drive");
    expect(headers[DEVICE_ID_HEADER]).toBe("node-abc");
  });

  it("stamps a timestamp the verifier's skew window will accept", () => {
    const headers = device.signRequest("starkeep-drive", "GET", "/health", undefined);
    expect(Math.abs(Date.now() - Number(headers[APP_TS_HEADER]))).toBeLessThan(5 * 60_000);
  });
});

describe("the canonical message, which is not ours to invent", () => {
  it("matches what an HMAC signer would produce over the same inputs", () => {
    // The device and the app sign *the same bytes* with different primitives.
    // Asserted by HMACing the message this module builds and comparing against
    // an independently assembled one — if the layout drifts, the two diverge.
    const ts = 1_700_000_000_000;
    const mine = signedMessage("photos", "POST", "/data/records", ts, new TextEncoder().encode("x"));
    const theirs = Buffer.concat([
      Buffer.from(`photos:POST:/data/records:${ts}:`, "utf8"),
      Buffer.from("x", "utf8"),
    ]);
    expect(createHmac("sha256", "k").update(mine).digest("hex")).toBe(
      createHmac("sha256", "k").update(theirs).digest("hex"),
    );
  });

  it("strips the query string, because the verifier does", () => {
    expect(canonicalSignedPath("/data/records?limit=10&cursor=abc")).toBe("/data/records");
  });

  it("percent-decodes, because API Gateway normalises before the handler routes", () => {
    expect(canonicalSignedPath("/data/records/a%2Fb")).toBe("/data/records/a/b");
  });

  it("survives a malformed escape rather than throwing", () => {
    // A path that cannot be decoded must still sign as *something*, or one bad
    // record id takes down the whole exchange.
    expect(canonicalSignedPath("/data/%E0%A4%A")).toBe("/data/%E0%A4%A");
  });
});
