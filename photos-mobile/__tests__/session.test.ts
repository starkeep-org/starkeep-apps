/**
 * Signing this phone in, against a fake cloud and a fake pool.
 *
 * The rules a sign-in follows — refresh, offline, rejection, revocation — are
 * protocol-primitives' and tested there. What is the phone's own is where the
 * session lives across a relaunch, which cloud it belongs to, and the
 * new-password step an admin-created account answers its first sign-in with.
 */
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
} from "../src/auth/session";
import { fakeSecureStore } from "./helpers/fake-secure-store";

const CLOUD = "https://d1.cloudfront.net";
const AUTH = { region: "us-east-2", userPoolId: "us-east-2_Pool1", deviceClientId: "deviceclient1" };

function idToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
}

/**
 * The cloud's discovery route and the pool's API, as one `fetch`. The pool
 * knows one account, which starts on a temporary password and has a data
 * library unless `groups` says otherwise.
 */
function fakeCloud(options: { groups?: string[] } = {}) {
  const groups = options.groups ?? ["starkeep-users"];
  const calls: Array<{ url: string; target?: string; body?: Record<string, unknown> }> = [];
  let password = "Temp-1";
  let temporary = true;
  const revoked: string[] = [];
  let issued = 0;
  const tokens = () => {
    issued += 1;
    return {
      AuthenticationResult: {
        AccessToken: "access",
        IdToken: idToken({ sub: "user-1", email: "sam@example.com", exp: 2_000_000_000, "cognito:groups": groups }),
        RefreshToken: `refresh-${issued}`,
        ExpiresIn: 900,
      },
    };
  };
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url === `${CLOUD}/auth/config`) {
      calls.push({ url });
      return new Response(JSON.stringify(AUTH));
    }
    if (url === "https://cognito-idp.us-east-2.amazonaws.com/") {
      const target = String((init?.headers as Record<string, string>)["X-Amz-Target"]).split(".")[1]!;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, target, body });
      const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
      if (target === "InitiateAuth") {
        const params = body["AuthParameters"] as Record<string, string>;
        if (params["PASSWORD"] !== password) return reply(400, { __type: "NotAuthorizedException", message: "Incorrect username or password." });
        if (temporary) return reply(200, { ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "s1" });
        return reply(200, tokens());
      }
      if (target === "RespondToAuthChallenge") {
        password = String((body["ChallengeResponses"] as Record<string, string>)["NEW_PASSWORD"]);
        temporary = false;
        return reply(200, tokens());
      }
      if (target === "RevokeToken") {
        revoked.push(String(body["Token"]));
        return reply(200, {});
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, calls, revoked };
}

describe("signing in", () => {
  it("asks for a new password at the first sign-in, then keeps the session and its cloud", async () => {
    const { store } = fakeSecureStore();
    const cloud = fakeCloud();
    const args = { baseUrl: CLOUD, email: "sam@example.com", password: "Temp-1" };

    expect(await signInPhone(store, args, cloud.impl)).toEqual({ kind: "new-password-required" });
    expect(await loadSignedIn(store)).toBeNull();

    expect(await signInPhone(store, { ...args, newPassword: "Chosen-2" }, cloud.impl)).toEqual({
      kind: "signed-in",
      email: "sam@example.com",
      userId: "user-1",
    });
    // A relaunch reads it back from the secure store alone.
    expect(await loadSignedIn(store)).toEqual({ cloud: { baseUrl: CLOUD, auth: AUTH }, email: "sam@example.com" });
    // The pool and client came from the cloud, not from anything the phone was given.
    expect(cloud.calls.filter((c) => c.target === "InitiateAuth")[0]!.body!["ClientId"]).toBe("deviceclient1");
  });

  it("stores the refresh token and never an ID token", async () => {
    const { store, items } = fakeSecureStore();
    const cloud = fakeCloud();
    await signInPhone(store, { baseUrl: CLOUD, email: "sam@example.com", password: "Temp-1", newPassword: "Chosen-2" }, cloud.impl);
    const stored = [...items.values()].join("\n");
    expect(stored).toContain("refresh-1");
    expect(stored).not.toContain("header.");
  });

  it("refuses an account with no data library, ends its sign-in, and keeps nothing", async () => {
    const { store, items } = fakeSecureStore();
    const cloud = fakeCloud({ groups: ["starkeep-admins"] });
    await expect(
      signInPhone(store, { baseUrl: CLOUD, email: "sam@example.com", password: "Temp-1", newPassword: "Chosen-2" }, cloud.impl),
    ).rejects.toThrow(NoDataLibraryError);
    expect(cloud.revoked).toEqual(["refresh-1"]);
    expect(items.size).toBe(0);
  });

  it("says why a wrong password failed, and keeps nothing", async () => {
    const { store, items } = fakeSecureStore();
    await expect(
      signInPhone(store, { baseUrl: CLOUD, email: "sam@example.com", password: "wrong" }, fakeCloud().impl),
    ).rejects.toThrow(/Incorrect username or password/);
    expect(items.size).toBe(0);
  });

  it("signs in the account the library already belongs to", async () => {
    const { store } = fakeSecureStore();
    const cloud = fakeCloud();
    const outcome = await signInPhone(
      store,
      { baseUrl: CLOUD, email: "sam@example.com", password: "Temp-1", newPassword: "Chosen-2", libraryOwner: "user-1" },
      cloud.impl,
    );
    expect(outcome.kind).toBe("signed-in");
  });

  it("refuses another account on a library that belongs to someone else, and ends that sign-in", async () => {
    // The phone would otherwise keep a session its library can never sync
    // with, and fail at binding on every round. Refused before anything is
    // stored, as the local data server refuses it.
    const { store, items } = fakeSecureStore();
    const cloud = fakeCloud();
    await expect(
      signInPhone(
        store,
        { baseUrl: CLOUD, email: "sam@example.com", password: "Temp-1", newPassword: "Chosen-2", libraryOwner: "someone-else" },
        cloud.impl,
      ),
    ).rejects.toBeInstanceOf(LibraryBelongsElsewhereError);
    expect(items.size).toBe(0);
    expect(cloud.revoked).toEqual(["refresh-1"]);
  });

  it("refuses an address that is not a Starkeep cloud", async () => {
    const { store } = fakeSecureStore();
    await expect(
      signInPhone(store, { baseUrl: "https://example.com", email: "a", password: "b" }, fakeCloud().impl),
    ).rejects.toThrow(/404/);
  });
});

describe("signing out", () => {
  it("revokes the session at the pool and keeps the cloud's address", async () => {
    const { store } = fakeSecureStore();
    const cloud = fakeCloud();
    await signInPhone(store, { baseUrl: CLOUD, email: "sam@example.com", password: "Temp-1", newPassword: "Chosen-2" }, cloud.impl);

    expect(await signOutPhone(store, cloud.impl)).toBe("revoked");
    expect(cloud.revoked).toEqual(["refresh-1"]);
    expect(await loadSignedIn(store)).toBeNull();
    expect(await createSessionStore(store).readPendingRevocation()).toBeNull();
  });

  it("finishes a revocation a tunnel interrupted, at the next launch", async () => {
    const { store } = fakeSecureStore();
    const cloud = fakeCloud();
    await signInPhone(store, { baseUrl: CLOUD, email: "sam@example.com", password: "Temp-1", newPassword: "Chosen-2" }, cloud.impl);
    const offline = (async () => {
      throw new TypeError("Network request failed");
    }) as typeof fetch;

    expect(await signOutPhone(store, offline)).toBe("pending");
    expect(await loadSignedIn(store)).toBeNull();

    expect(await finishPendingSignOut(store, cloud.impl)).toBe("revoked");
    expect(cloud.revoked).toEqual(["refresh-1"]);
  });

  it("is a no-op on a phone that never signed in", async () => {
    expect(await signOutPhone(fakeSecureStore().store)).toBe("none");
  });
});

describe("the session store", () => {
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

/**
 * Clouds with pools that can go out of reach, for the cases where a phone
 * signs in again, signs out twice, or moves to another cloud. Each pool
 * revokes only tokens it issued, as Cognito does; any other token is refused.
 *
 * The move between clouds and the two sign-outs started as `it.fails` in the
 * 2026-10-18 test-gap review. See
 * `~/projects/starkeep/assessment-failing-tests-device-sign-in-2026-10-18.md`,
 * section "2. The pending revocation: retry at sign-in, and keep the pool".
 */
function clouds() {
  const pools = new Map<
    string,
    { baseUrl: string; auth: typeof AUTH; issued: Set<string>; revoked: string[]; online: boolean; count: number }
  >();
  function addCloud(baseUrl: string, region: string, tag: string) {
    const auth = { region, userPoolId: `${region}_${tag}`, deviceClientId: `client${tag}` };
    const pool = { baseUrl, auth, issued: new Set<string>(), revoked: [] as string[], online: true, count: 0 };
    pools.set(region, pool);
    return pool;
  }
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    for (const pool of pools.values()) {
      if (url === `${pool.baseUrl}/auth/config`) return new Response(JSON.stringify(pool.auth));
      if (url === `https://cognito-idp.${pool.auth.region}.amazonaws.com/`) {
        if (!pool.online) throw new TypeError("Network request failed");
        const target = String((init?.headers as Record<string, string>)["X-Amz-Target"]).split(".")[1]!;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (target === "InitiateAuth") {
          pool.count += 1;
          const refresh = `${pool.auth.userPoolId}-refresh-${pool.count}`;
          pool.issued.add(refresh);
          return new Response(
            JSON.stringify({
              AuthenticationResult: {
                AccessToken: "access",
                IdToken: idToken({
                  sub: `user-${pool.auth.userPoolId}`,
                  email: "sam@example.com",
                  exp: 2_000_000_000,
                  "cognito:groups": ["starkeep-users"],
                }),
                RefreshToken: refresh,
                ExpiresIn: 900,
              },
            }),
          );
        }
        if (target === "RevokeToken") {
          const token = String(body["Token"]);
          if (!pool.issued.has(token)) {
            return new Response(JSON.stringify({ __type: "UnauthorizedException", message: "Invalid token" }), {
              status: 400,
            });
          }
          pool.revoked.push(token);
          return new Response("{}");
        }
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { addCloud, impl };
}

/** Let a revocation the sign-in started in the background finish. */
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("signing in again, signing out twice, and moving clouds", () => {
  it("revokes the previous refresh token when the phone signs in again", async () => {
    const { store } = fakeSecureStore();
    const world = clouds();
    const x = world.addCloud(CLOUD, "us-east-2", "PoolX");
    const args = { baseUrl: CLOUD, email: "sam@example.com", password: "pw" };

    await signInPhone(store, args, world.impl);
    const first = (await createSessionStore(store).read())!.refreshToken;
    await signInPhone(store, args, world.impl);
    await settle();

    expect(x.revoked).toEqual([first]);
    expect((await createSessionStore(store).read())!.refreshToken).not.toBe(first);
  });

  it("revokes the old cloud's token at the old cloud's pool, after moving to a new cloud", async () => {
    // The waiting revocation outlives the old cloud's record, so it carries
    // its own pool. The new cloud's pool would refuse a token it never issued,
    // and the phone would take the refusal to mean "revoked".
    const { store } = fakeSecureStore();
    const world = clouds();
    const x = world.addCloud(CLOUD, "us-east-2", "PoolX");
    const y = world.addCloud("https://d2.cloudfront.net", "us-west-2", "PoolY");

    await signInPhone(store, { baseUrl: x.baseUrl, email: "sam@example.com", password: "pw" }, world.impl);
    const xToken = (await createSessionStore(store).read())!.refreshToken;

    x.online = false;
    await signInPhone(store, { baseUrl: y.baseUrl, email: "sam@example.com", password: "pw" }, world.impl);
    await settle();
    expect(x.revoked).toEqual([]);

    x.online = true;
    await finishPendingSignOut(store, world.impl);
    expect(x.revoked).toEqual([xToken]);
  });

  it("keeps both tokens to revoke when the phone signs out twice without reaching the pool", async () => {
    // One pending-revocation item. The sign-in between the two sign-outs
    // reaches the pool and finishes the first, so the second finds it empty.
    const { store } = fakeSecureStore();
    const world = clouds();
    const x = world.addCloud(CLOUD, "us-east-2", "PoolX");
    const args = { baseUrl: CLOUD, email: "sam@example.com", password: "pw" };

    await signInPhone(store, args, world.impl);
    const first = (await createSessionStore(store).read())!.refreshToken;
    x.online = false;
    expect(await signOutPhone(store, world.impl)).toBe("pending");

    x.online = true;
    await signInPhone(store, args, world.impl);
    expect(x.revoked).toEqual([first]);
    const second = (await createSessionStore(store).read())!.refreshToken;
    x.online = false;
    expect(await signOutPhone(store, world.impl)).toBe("pending");

    x.online = true;
    await finishPendingSignOut(store, world.impl);
    expect(x.revoked.sort()).toEqual([first, second].sort());
  });
});
