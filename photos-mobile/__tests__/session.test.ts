/**
 * Signing this phone in, against a fake cloud, a fake sign-in page, a fake
 * pool and a fake Keystore.
 *
 * The rules a session follows — refresh, offline, rejection, revocation — are
 * protocol-primitives' and tested there. What is the phone's own is the
 * browser sign-in with PKCE, the attested key registered before anything is
 * kept, where the session lives across a relaunch, and which cloud it belongs
 * to.
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkCloudAddress,
  createSessionStore,
  finishPendingSignOut,
  LibraryBelongsElsewhereError,
  loadSignedIn,
  NoDataLibraryError,
  notifySessionRejected,
  onSessionRejected,
  signInPhone,
  signOutPhone,
  type PhoneSignInDeps,
} from "../src/auth/session";
import { AttestationRefusedError, ATTESTED_KEY_ALIAS, type AttestedKeyNative } from "../src/auth/attested-key";
import { CALLBACK_URL, SignInCancelledError, type AuthSessionResult } from "../src/auth/browser-sign-in";
import { fakeSecureStore } from "./helpers/fake-secure-store";

const CLOUD = "https://d1.cloudfront.net";

function idToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
}

const sha256 = async (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

function query(url: string): URLSearchParams {
  return new URLSearchParams(url.slice(url.indexOf("?") + 1));
}

/** A Keystore that records what it was asked to do. */
function fakeKeystore() {
  const generated: Array<{ alias: string; challenge: string }> = [];
  const removed: string[] = [];
  const native: AttestedKeyNative = {
    async generate(alias, challenge) {
      generated.push({ alias, challenge });
      return ["bGVhZg==", "aW50ZXJtZWRpYXRl"];
    },
    async signDigest() {
      return "c2ln";
    },
    async remove(alias) {
      removed.push(alias);
    },
  };
  return { native, generated, removed };
}

interface FakeCloudOptions {
  groups?: string[];
  /** The cloud refuses the attestation with this reason. */
  refuseKey?: string;
  /** What the sign-in page does: answer for the attempt, cancel, or answer for another attempt. */
  page?: "sign-in" | "cancel" | "wrong-state" | "error";
}

/**
 * One cloud: its discovery route, its managed login page and token endpoint,
 * its pool's API, and its key registration route, as one `fetch` plus the
 * browser's auth session.
 */
function fakeCloud(options: FakeCloudOptions = {}) {
  const groups = options.groups ?? ["starkeep-users"];
  const domain = "starkeep-1.auth.us-east-2.amazoncognito.com";
  // What the phone keeps: the mobile half of the discovery answer.
  const auth = {
    region: "us-east-2",
    userPoolId: "us-east-2_Pool1",
    mobileClientId: "mobileclient1",
    cognitoDomain: domain,
  };
  const revoked: string[] = [];
  const keyRegistrations: Array<{ token: string; chain: string[] }> = [];
  const pendingCodes = new Map<string, string>();
  let issued = 0;
  const authorizeRequests: URLSearchParams[] = [];

  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url === `${CLOUD}/auth/config`) {
      return new Response(JSON.stringify({ ...auth, deviceClientId: "deviceclient1" }));
    }
    if (url === `https://${domain}/oauth2/token`) {
      const form = new URLSearchParams(String(init?.body));
      const challenge = pendingCodes.get(form.get("code") ?? "");
      // PKCE: the verifier must hash to the challenge the authorize request sent.
      if (!challenge || b64url(await sha256(new TextEncoder().encode(form.get("code_verifier")!))) !== challenge) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      issued += 1;
      return new Response(
        JSON.stringify({
          id_token: idToken({ sub: "user-1", email: "sam@example.com", exp: 2_000_000_000, "cognito:groups": groups, n: issued }),
          access_token: "access",
          refresh_token: `refresh-${issued}`,
          expires_in: 900,
        }),
      );
    }
    if (url === "https://cognito-idp.us-east-2.amazonaws.com/") {
      const target = String((init?.headers as Record<string, string>)["X-Amz-Target"]).split(".")[1]!;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (target === "RevokeToken") {
        revoked.push(String(body["Token"]));
        return new Response("{}");
      }
    }
    if (url === `${CLOUD}/apps/starkeep-drive/mobile/keys`) {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as { chain: string[] };
      keyRegistrations.push({ token: headers.get("X-Starkeep-User-Token")!, chain: body.chain });
      if (options.refuseKey) return new Response(JSON.stringify({ error: options.refuseKey }), { status: 403 });
      return new Response(JSON.stringify({ keyId: "k".repeat(64), appId: "photos" }));
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const keystore = fakeKeystore();
  const deps: PhoneSignInDeps = {
    async openAuthSession(url, redirectUrl): Promise<AuthSessionResult> {
      const q = query(url);
      authorizeRequests.push(q);
      expect(redirectUrl).toBe(CALLBACK_URL);
      if (options.page === "cancel") return { type: "cancel" };
      const state = options.page === "wrong-state" ? "someone-elses" : q.get("state")!;
      if (options.page === "error") {
        return { type: "success", url: `${CALLBACK_URL}?error=access_denied&error_description=Locked&state=${state}` };
      }
      const code = `code-${pendingCodes.size + 1}`;
      pendingCodes.set(code, q.get("code_challenge")!);
      return { type: "success", url: `${CALLBACK_URL}?code=${code}&state=${state}` };
    },
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    sha256,
    attestedKey: keystore.native,
    fetch: impl,
  };
  return { impl, deps, auth, revoked, keyRegistrations, keystore, authorizeRequests };
}

describe("signing in", () => {
  it("signs in on the cloud's page with PKCE, registers a key, and keeps the session and its cloud", async () => {
    const { store } = fakeSecureStore();
    const cloud = fakeCloud();

    expect(await signInPhone(store, { baseUrl: CLOUD }, cloud.deps)).toEqual({
      email: "sam@example.com",
      userId: "user-1",
    });

    // The page was the cloud's, on the mobile-apps client, returning to this app.
    const authorize = cloud.authorizeRequests[0]!;
    expect(authorize.get("client_id")).toBe("mobileclient1");
    expect(authorize.get("redirect_uri")).toBe(CALLBACK_URL);
    expect(authorize.get("code_challenge_method")).toBe("S256");
    // A relaunch reads it back from the secure store alone.
    expect(await loadSignedIn(store)).toEqual({ cloud: { baseUrl: CLOUD, auth: cloud.auth }, email: "sam@example.com" });
  });

  it("attests the key to this sign-in's token, and keeps the key's id", async () => {
    const { store, items } = fakeSecureStore();
    const cloud = fakeCloud();
    await signInPhone(store, { baseUrl: CLOUD }, cloud.deps);

    const [registration] = cloud.keyRegistrations;
    const [generated] = cloud.keystore.generated;
    expect(generated!.alias).toBe(ATTESTED_KEY_ALIAS);
    // The challenge is SHA-256 of the very token the registration carried.
    const expected = Buffer.from(await sha256(new TextEncoder().encode(registration!.token))).toString("base64");
    expect(generated!.challenge).toBe(expected);
    expect(registration!.chain).toEqual(["bGVhZg==", "aW50ZXJtZWRpYXRl"]);
    expect(items.get("starkeep.session.keyId")).toBe("k".repeat(64));
  });

  it("stores the refresh token and never an ID token", async () => {
    const { store, items } = fakeSecureStore();
    await signInPhone(store, { baseUrl: CLOUD }, fakeCloud().deps);
    const stored = [...items.values()].join("\n");
    expect(stored).toContain("refresh-1");
    expect(stored).not.toContain("header.");
  });

  it("keeps nothing when the person closes the page", async () => {
    const { store, items } = fakeSecureStore();
    await expect(signInPhone(store, { baseUrl: CLOUD }, fakeCloud({ page: "cancel" }).deps)).rejects.toThrow(
      SignInCancelledError,
    );
    expect(items.size).toBe(0);
  });

  it("refuses a code returned for another sign-in attempt", async () => {
    const { store, items } = fakeSecureStore();
    await expect(signInPhone(store, { baseUrl: CLOUD }, fakeCloud({ page: "wrong-state" }).deps)).rejects.toThrow(
      /another sign-in/,
    );
    expect(items.size).toBe(0);
  });

  it("says why the page refused", async () => {
    const { store } = fakeSecureStore();
    await expect(signInPhone(store, { baseUrl: CLOUD }, fakeCloud({ page: "error" }).deps)).rejects.toThrow(/Locked/);
  });

  it("refuses an account with no data library, ends its sign-in, and keeps nothing", async () => {
    const { store, items } = fakeSecureStore();
    const cloud = fakeCloud({ groups: ["starkeep-admins"] });
    await expect(signInPhone(store, { baseUrl: CLOUD }, cloud.deps)).rejects.toThrow(NoDataLibraryError);
    expect(cloud.revoked).toEqual(["refresh-1"]);
    expect(cloud.keyRegistrations).toEqual([]);
    expect(items.size).toBe(0);
  });

  it("refuses a phone the cloud cannot attest, ends the sign-in, and keeps nothing", async () => {
    const { store, items } = fakeSecureStore();
    const cloud = fakeCloud({ refuseKey: "The device's bootloader is unlocked" });
    await expect(signInPhone(store, { baseUrl: CLOUD }, cloud.deps)).rejects.toThrow(AttestationRefusedError);
    await expect(signInPhone(store, { baseUrl: CLOUD }, cloud.deps)).rejects.toThrow(/bootloader is unlocked/);
    expect(cloud.revoked).toEqual(["refresh-1", "refresh-2"]);
    expect(cloud.keystore.removed).toContain(ATTESTED_KEY_ALIAS);
    expect(items.size).toBe(0);
  });

  it("refuses a build with no Keystore module, rather than syncing unattested", async () => {
    const { store, items } = fakeSecureStore();
    const cloud = fakeCloud();
    await expect(signInPhone(store, { baseUrl: CLOUD }, { ...cloud.deps, attestedKey: null })).rejects.toThrow(
      /cannot prove which app/,
    );
    expect(items.size).toBe(0);
  });

  it("signs in the account the library already belongs to", async () => {
    const { store } = fakeSecureStore();
    const outcome = await signInPhone(store, { baseUrl: CLOUD, libraryOwner: "user-1" }, fakeCloud().deps);
    expect(outcome.userId).toBe("user-1");
  });

  it("refuses another account on a library that belongs to someone else, and ends that sign-in", async () => {
    // The phone would otherwise keep a session its library can never sync
    // with, and fail at binding on every round. Refused before anything is
    // stored, as the local data server refuses it.
    const { store, items } = fakeSecureStore();
    const cloud = fakeCloud();
    await expect(signInPhone(store, { baseUrl: CLOUD, libraryOwner: "someone-else" }, cloud.deps)).rejects.toBeInstanceOf(
      LibraryBelongsElsewhereError,
    );
    expect(items.size).toBe(0);
    expect(cloud.revoked).toEqual(["refresh-1"]);
  });

  it("refuses an address that is not a Starkeep cloud", async () => {
    const { store } = fakeSecureStore();
    await expect(signInPhone(store, { baseUrl: "https://example.com" }, fakeCloud().deps)).rejects.toThrow(/404/);
  });

  it("refuses a cloud that offers no mobile sign-in yet", async () => {
    const { store } = fakeSecureStore();
    const cloud = fakeCloud();
    const older = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(input) === `${CLOUD}/auth/config`
        ? new Response(JSON.stringify({ region: "us-east-2", userPoolId: "us-east-2_Pool1", deviceClientId: "d" }))
        : cloud.impl(input, init)) as typeof fetch;
    await expect(signInPhone(store, { baseUrl: CLOUD }, { ...cloud.deps, fetch: older })).rejects.toThrow(
      /does not offer sign-in to mobile apps/,
    );
  });
});

describe("signing out", () => {
  it("revokes the session at the pool, forgets the key, and keeps the cloud's address", async () => {
    const { store, items } = fakeSecureStore();
    const cloud = fakeCloud();
    await signInPhone(store, { baseUrl: CLOUD }, cloud.deps);

    expect(await signOutPhone(store, cloud.keystore.native, cloud.impl)).toBe("revoked");
    expect(cloud.revoked).toEqual(["refresh-1"]);
    expect(await loadSignedIn(store)).toBeNull();
    expect(items.has("starkeep.session.keyId")).toBe(false);
    expect(cloud.keystore.removed).toEqual([ATTESTED_KEY_ALIAS]);
    expect(await createSessionStore(store).readPendingRevocation()).toBeNull();
  });

  it("finishes a revocation a tunnel interrupted, at the next launch", async () => {
    const { store } = fakeSecureStore();
    const cloud = fakeCloud();
    await signInPhone(store, { baseUrl: CLOUD }, cloud.deps);
    const offline = (async () => {
      throw new TypeError("Network request failed");
    }) as typeof fetch;

    expect(await signOutPhone(store, cloud.keystore.native, offline)).toBe("pending");
    expect(await loadSignedIn(store)).toBeNull();

    expect(await finishPendingSignOut(store, cloud.impl)).toBe("revoked");
    expect(cloud.revoked).toEqual(["refresh-1"]);
  });

  it("is a no-op on a phone that never signed in", async () => {
    expect(await signOutPhone(fakeSecureStore().store, null)).toBe("none");
  });
});

describe("the session store", () => {
  const AUTH = fakeCloud().auth;

  it("keeps a pending revocation and its pool apart from the session, across a relaunch", async () => {
    const { store } = fakeSecureStore();
    const sessions = createSessionStore(store);
    await sessions.write({ refreshToken: "r1", email: "a@example.com" });
    await sessions.writePendingRevocation({ refreshToken: "r0", auth: AUTH });
    await sessions.clear();
    expect(await createSessionStore(store).readPendingRevocation()).toEqual({ refreshToken: "r0", auth: AUTH });
  });

  it("treats an email with no refresh token as no session", async () => {
    const { store, items } = fakeSecureStore();
    items.set("starkeep.session.email", "a@example.com");
    expect(await createSessionStore(store).read()).toBeNull();
  });

  it("treats a session from the old device-client sign-in as no session", async () => {
    // Its cloud names no mobile-apps client, so the phone signs in again,
    // which registers the attested key a scoped sync needs.
    const { store, items } = fakeSecureStore();
    items.set("starkeep.session.refreshToken", "r-old");
    items.set(
      "starkeep.session.cloud",
      JSON.stringify({ baseUrl: CLOUD, auth: { region: "us-east-2", userPoolId: "us-east-2_Pool1", deviceClientId: "d" } }),
    );
    expect(await loadSignedIn(store)).toBeNull();
  });
});

describe("checkCloudAddress", () => {
  it("accepts https and drops a trailing slash", () => {
    expect(checkCloudAddress(" https://d1.cloudfront.net/ ")).toEqual({ ok: true, baseUrl: CLOUD });
  });

  it("refuses plain http, except to a development machine", () => {
    expect(checkCloudAddress("http://d1.cloudfront.net").ok).toBe(false);
    expect(checkCloudAddress("http://10.0.2.2:4100").ok).toBe(true);
  });

  it("refuses something that is not an address", () => {
    expect(checkCloudAddress("d1").ok).toBe(false);
  });
});

describe("a sign-in the pool ends", () => {
  it("tells every listener why, until it unsubscribes", () => {
    const heard: string[] = [];
    const stop = onSessionRejected((reason) => heard.push(reason));
    notifySessionRejected("Refresh Token has been revoked");
    stop();
    notifySessionRejected("again");
    expect(heard).toEqual(["Refresh Token has been revoked"]);
  });
});

/** Let a revocation the sign-in started in the background finish. */
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("signing in again", () => {
  it("revokes the previous refresh token, and registers a fresh key", async () => {
    const { store } = fakeSecureStore();
    const cloud = fakeCloud();

    await signInPhone(store, { baseUrl: CLOUD }, cloud.deps);
    const first = (await createSessionStore(store).read())!.refreshToken;
    await signInPhone(store, { baseUrl: CLOUD }, cloud.deps);
    await settle();

    expect(cloud.revoked).toEqual([first]);
    expect((await createSessionStore(store).read())!.refreshToken).not.toBe(first);
    expect(cloud.keystore.generated).toHaveLength(2);
  });
});
