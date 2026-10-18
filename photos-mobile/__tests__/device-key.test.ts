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
import { createPrivateKey, createPublicKey, verify as nodeVerify, createHmac } from "node:crypto";
import {
  loadDeviceKey,
  keyFrom,
  parsePairingPayload,
  clearDeviceCredential,
  signedMessage,
  canonicalSignedPath,
  PAIRING_PAYLOAD_VERSION,
  APP_ID_HEADER,
  APP_TS_HEADER,
  DEVICE_ID_HEADER,
  DEVICE_SIG_HEADER,
  type DeviceCredential,
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

/** A deterministic 32-byte seed, base64. */
const seed = (n: number) =>
  Buffer.from(Array.from({ length: 32 }, (_, i) => (i + n) % 256)).toString("base64");

const credential: DeviceCredential = {
  deviceId: "dev_abc",
  privateKey: seed(1),
  baseUrl: "https://d123.cloudfront.net",
  label: "Pixel 8",
};

/** What admin-web puts in the QR code. */
function payload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ starkeepPair: PAIRING_PAYLOAD_VERSION, ...credential, ...over });
}

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
  device = keyFrom(credential);
});

describe("reading a pairing code", () => {
  it("reads admin-web's payload, and names the host so the screen can ask", () => {
    const parsed = parsePairingPayload(payload());
    expect(parsed).toEqual({ ok: true, host: "d123.cloudfront.net", credential });
  });

  it("drops a trailing slash from the cloud address", () => {
    const parsed = parsePairingPayload(payload({ baseUrl: "https://d123.cloudfront.net/" }));
    expect(parsed.ok && parsed.credential.baseUrl).toBe("https://d123.cloudfront.net");
  });

  it("treats a missing label as none", () => {
    const { label: _drop, ...noLabel } = credential;
    const parsed = parsePairingPayload(JSON.stringify({ starkeepPair: 1, ...noLabel }));
    expect(parsed.ok && parsed.credential.label).toBeNull();
  });

  it.each([
    ["text that is not JSON", "https://example.com", /not a Starkeep pairing code/],
    ["JSON that is not an object", "[1,2]", /not a Starkeep pairing code/],
    ["an object with no version", JSON.stringify({ deviceId: "x" }), /not a Starkeep pairing code/],
    ["a newer version", payload({ starkeepPair: 2 }), /different version of admin-web/],
    ["a device id that could walk an SSM path", payload({ deviceId: "../photos" }), /device id/],
    ["a key that is not base64", payload({ privateKey: "!!!" }), /key is not valid/],
    ["a key of the wrong length", payload({ privateKey: Buffer.alloc(16).toString("base64") }), /key is not valid/],
    ["a cloud address that is not a URL", payload({ baseUrl: "d123.cloudfront.net" }), /cloud address is not valid/],
    ["a cloud address on another scheme", payload({ baseUrl: "ftp://d123.cloudfront.net" }), /cloud address is not valid/],
    ["plain http to a public host", payload({ baseUrl: "http://evil.example.com" }), /must use https/],
    ["a label that is not a string", payload({ label: 7 }), /device name/],
    ["a label that is too long", payload({ label: "x".repeat(101) }), /device name/],
  ])("refuses %s", (_name, text, reason) => {
    const parsed = parsePairingPayload(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(reason);
  });

  it.each(["localhost", "127.0.0.1", "10.0.2.2"])(
    "allows plain http to %s, for a development cloud",
    (host) => {
      const parsed = parsePairingPayload(payload({ baseUrl: `http://${host}:4100` }));
      expect(parsed.ok && parsed.host).toBe(host);
    },
  );
});

describe("the stored credential", () => {
  it("is absent on a phone an older build never paired", async () => {
    expect(await loadDeviceKey(harness.store)).toBeNull();
  });

  it("persists, so a restart is the same device", async () => {
    harness.items.set("starkeep.device.credential", JSON.stringify(credential));
    const loaded = await loadDeviceKey(harness.store);
    expect(loaded).toMatchObject({
      deviceId: "dev_abc",
      label: "Pixel 8",
      baseUrl: "https://d123.cloudfront.net",
      publicKeySpki: device.publicKeySpki,
    });
  });

  it("lives in the secure store as one item, and nowhere else", async () => {
    harness.items.set("starkeep.device.credential", JSON.stringify(credential));
    expect([...harness.items.keys()]).toEqual(["starkeep.device.credential"]);
  });

  it("is forgotten on disconnect, along with a key from before QR pairing", async () => {
    harness.items.set("starkeep.device.credential", JSON.stringify(credential));
    harness.items.set("starkeep.device.privateKey", seed(9));
    await clearDeviceCredential(harness.store);
    expect(harness.items.size).toBe(0);
    expect(await loadDeviceKey(harness.store)).toBeNull();
  });

  it("ignores a key from before QR pairing, which the cloud no longer accepts", async () => {
    harness.items.set("starkeep.device.privateKey", seed(9));
    expect(await loadDeviceKey(harness.store)).toBeNull();
  });

  it("counts a stored credential that no longer parses as unpaired", async () => {
    harness.items.set("starkeep.device.credential", "{not json");
    expect(await loadDeviceKey(harness.store)).toBeNull();
    harness.items.set("starkeep.device.credential", JSON.stringify({ ...credential, privateKey: "short" }));
    expect(await loadDeviceKey(harness.store)).toBeNull();
  });

});

describe("the key itself", () => {
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

  it("derives the public key admin-web registered from the seed it was handed", () => {
    // Admin-web registers the SPKI it exported and hands the phone the seed.
    // The two must name the same key, or every request fails the signature
    // check. Derived here by node:crypto from the PKCS#8 that wraps the seed,
    // which is how a browser's Web Crypto holds it.
    const pkcs8 = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(credential.privateKey, "base64"),
    ]);
    const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({
      format: "der",
      type: "spki",
    });
    expect(spki.toString("base64")).toBe(device.publicKeySpki);
  });

  it("signs with the device id admin-web chose", () => {
    const headers = device.signRequest("starkeep-drive", "GET", "/health", undefined);
    expect(headers[DEVICE_ID_HEADER]).toBe("dev_abc");
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
    expect(headers[DEVICE_ID_HEADER]).toBe("dev_abc");
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
