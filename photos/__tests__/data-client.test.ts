/**
 * Data-plane source resolution regression tests.
 *
 * These lock the invariant that broke the cloud Photos app on reinstall: the
 * browser must ALWAYS route data-plane calls through the same-origin
 * `/api/local-data` proxy (which HMAC-signs server-side), and must NEVER talk
 * to a data server directly with a bearer token — the cloud data server's data
 * plane is HMAC-only and 401s a token-only request with "Missing
 * X-Starkeep-App-{Id,Sig,Ts} headers".
 *
 * `/api/resize` is deliberately different: it's the app's OWN JWT-gated Lambda,
 * reached directly on the gateway with a bearer token — that's
 * `resolveAppApiSource`, exercised separately below. Where that token comes
 * from changed with the session layer: the page used to hold a Cognito refresh
 * token in localStorage and mint against it, and now asks its own server,
 * which holds the refresh token in an HttpOnly cookie. The assertions here are
 * about the resulting header either way, so they say nothing about the cookie
 * — but the fetch mock below is the whole of what the browser now does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable stand-ins the hoisted mocks read, so each test can set the scenario.
const runtimeConfig: { value: { apiGatewayUrl?: string } | null } = { value: null };
const session: { accessToken: string | null; fails: boolean } = {
  accessToken: null,
  fails: false,
};

vi.mock("../src/lib/runtime-config", () => ({
  fetchRuntimeConfig: vi.fn(async () => runtimeConfig.value),
}));

/** The session route the page now asks for a token, in place of Cognito. */
let fetchMock: ReturnType<typeof vi.fn>;

// data-client memoizes the target + token at module scope, so re-import fresh
// per test to isolate the local/remote decision.
async function freshDataClient() {
  vi.resetModules();
  return import("../src/lib/data-client");
}

const savedBasePath = process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH;

beforeEach(() => {
  runtimeConfig.value = null;
  session.accessToken = null;
  session.fails = false;
  delete process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH;
  fetchMock = vi.fn(async (url: string) => {
    if (!String(url).includes("/api/session/token")) throw new Error(`unexpected fetch: ${url}`);
    if (session.fails) return new Response("nope", { status: 401 });
    return Response.json({ accessToken: session.accessToken, expiresIn: 3600 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  if (savedBasePath === undefined) delete process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH;
  else process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH = savedBasePath;
});

describe("resolveDataSource — always the signing proxy", () => {
  it("uses the /api/local-data proxy with no auth header when local (no apiGatewayUrl)", async () => {
    runtimeConfig.value = null;
    const { resolveDataSource } = await freshDataClient();
    expect(await resolveDataSource()).toEqual({ baseUrl: "/api/local-data", headers: {} });
  });

  it("STILL uses the proxy — not a direct gateway URL — when cloud-served (apiGatewayUrl set)", async () => {
    // This is the exact regression: the old code returned
    // `${apiGatewayUrl}/apps/photos` + a bearer token here, bypassing the
    // proxy, so the HMAC-only data server 401'd. The browser must never see
    // the gateway URL for the data plane.
    runtimeConfig.value = { apiGatewayUrl: "https://api.example.com" };
    session.accessToken = "an-access-token";
    const { resolveDataSource } = await freshDataClient();
    const source = await resolveDataSource();
    expect(source).toEqual({ baseUrl: "/api/local-data", headers: {} });
    expect(source.baseUrl).not.toContain("example.com");
    expect(source.headers).not.toHaveProperty("Authorization");
  });

  it("carries the app basePath so the proxy path resolves under /apps/photos in cloud", async () => {
    // Regression: the cloud SPA is mounted under /apps/<appId> (Next basePath).
    // Next does NOT prefix raw fetch() calls, so a root-absolute "/api/local-data"
    // bypasses the app and the API Gateway answers `{"message":"Not Found"}` (404)
    // — the exact "nothing loads after sign-in" failure. resolveDataSource must
    // prepend the basePath via withBasePath.
    process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH = "/apps/photos";
    const { resolveDataSource } = await freshDataClient();
    expect(await resolveDataSource()).toEqual({
      baseUrl: "/apps/photos/api/local-data",
      headers: {},
    });
  });
});

describe("resolveAppApiSource — the app's own JWT-gated routes (e.g. /api/resize)", () => {
  it("is same-origin with no auth when local", async () => {
    runtimeConfig.value = null;
    const { resolveAppApiSource } = await freshDataClient();
    expect(await resolveAppApiSource()).toEqual({ baseUrl: "", headers: {} });
  });

  it("targets the gateway under /apps/photos with a bearer token when remote", async () => {
    runtimeConfig.value = { apiGatewayUrl: "https://api.example.com/" };
    session.accessToken = "an-access-token";
    const { resolveAppApiSource } = await freshDataClient();
    expect(await resolveAppApiSource()).toEqual({
      baseUrl: "https://api.example.com/apps/photos",
      headers: { Authorization: "Bearer an-access-token" },
    });
  });

  it("degrades to no auth header (rather than throwing) when the token can't be obtained", async () => {
    runtimeConfig.value = { apiGatewayUrl: "https://api.example.com" };
    session.fails = true;
    const { resolveAppApiSource } = await freshDataClient();
    const source = await resolveAppApiSource();
    expect(source.baseUrl).toBe("https://api.example.com/apps/photos");
    expect(source.headers).toEqual({});
  });

  it("asks its own server for the token, never Cognito", async () => {
    // The page holds no Cognito credential to mint from any more. If this ever
    // starts calling cognito-idp again, the refresh token has come back to the
    // browser and the whole layer has been undone.
    runtimeConfig.value = { apiGatewayUrl: "https://api.example.com" };
    session.accessToken = "an-access-token";
    const { resolveAppApiSource } = await freshDataClient();
    await resolveAppApiSource();
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls).toContain("/api/session/token");
    expect(urls.some((u) => u.includes("cognito-idp"))).toBe(false);
  });

  it("carries the basePath on the token request, or it 404s under /apps/photos", async () => {
    process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH = "/apps/photos";
    runtimeConfig.value = { apiGatewayUrl: "https://api.example.com" };
    session.accessToken = "an-access-token";
    const { resolveAppApiSource } = await freshDataClient();
    await resolveAppApiSource();
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain(
      "/apps/photos/api/session/token",
    );
  });
});

describe("fetchWithSession — one refresh-and-retry when the gateway refuses", () => {
  /**
   * The gateway authorizer cannot set cookies, so an expired sk_token yields a
   * bare refusal. Recovering in one place beats every call site remembering to.
   *
   * 403 matters as much as 401. The authorizer names `Cookie` as its identity
   * source, so a request carrying no cookie never reaches it and gets 401,
   * while any cookie runs it and surfaces the denial as 403. A browser holds
   * `sk_session` for weeks after `sk_token` expires, so it is always in the
   * second case — and while this read only 401, the recovery never once ran.
   */
  async function withResponses(responses: Response[]) {
    const calls: string[] = [];
    const mock = vi.fn(async (url: string) => {
      calls.push(String(url));
      return responses.shift() ?? new Response(null, { status: 500 });
    });
    vi.stubGlobal("fetch", mock);
    const { fetchWithSession } = await freshDataClient();
    return { fetchWithSession, calls };
  }

  /**
   * These tests run under the `node` environment, so there is no `window` to
   * take a location from. Standing one up is also the assertion: the recovery
   * has to be inert wherever `window` is absent, because the same module is
   * imported by route handlers that run on the server.
   */
  function captureNavigation(): string[] {
    const replaced: string[] = [];
    vi.stubGlobal("window", {
      location: { pathname: "/browse", replace: (url: string) => replaced.push(url) },
    });
    return replaced;
  }

  it("passes a successful response straight through", async () => {
    const { fetchWithSession, calls } = await withResponses([new Response("ok", { status: 200 })]);
    expect((await fetchWithSession("/api/local-data/x")).status).toBe(200);
    expect(calls).toEqual(["/api/local-data/x"]);
  });

  it("refreshes and retries once on a 401", async () => {
    const { fetchWithSession, calls } = await withResponses([
      new Response(null, { status: 401 }),
      new Response(null, { status: 200 }),
      new Response("ok", { status: 200 }),
    ]);
    expect((await fetchWithSession("/api/local-data/x")).status).toBe(200);
    expect(calls).toEqual(["/api/local-data/x", "/api/session/refresh", "/api/local-data/x"]);
  });

  it("returns the original 401 when the refresh itself fails, rather than looping", async () => {
    const { fetchWithSession, calls } = await withResponses([
      new Response(null, { status: 401 }),
      new Response(null, { status: 401 }),
    ]);
    expect((await fetchWithSession("/api/local-data/x")).status).toBe(401);
    expect(calls).toEqual(["/api/local-data/x", "/api/session/refresh"]);
  });

  it("does not retry twice — a second 401 is the answer", async () => {
    const { fetchWithSession, calls } = await withResponses([
      new Response(null, { status: 401 }),
      new Response(null, { status: 200 }),
      new Response(null, { status: 401 }),
    ]);
    expect((await fetchWithSession("/api/local-data/x")).status).toBe(401);
    expect(calls).toHaveLength(3);
  });

  it("refreshes and retries on a 403, the status a browser actually gets", async () => {
    // The whole bug. Any cookie makes the authorizer run, and its denial is a
    // 403 — so an hour-old tab filled with red status codes while a recovery
    // that only read 401 sat one branch away.
    const { fetchWithSession, calls } = await withResponses([
      new Response(null, { status: 403 }),
      new Response(null, { status: 200 }),
      new Response("ok", { status: 200 }),
    ]);
    expect((await fetchWithSession("/api/local-data/x")).status).toBe(200);
    expect(calls).toEqual(["/api/local-data/x", "/api/session/refresh", "/api/local-data/x"]);
  });

  it("sends the browser to sign-in when the refresh says the session is spent", async () => {
    // A 401 from /api/session/refresh means the refresh token itself is gone
    // and both cookies were cleared. Nothing the page can do recovers that, so
    // it goes where a reload would have gone.
    const replaced = captureNavigation();
    const { fetchWithSession } = await withResponses([
      new Response(null, { status: 403 }),
      new Response(null, { status: 401 }),
    ]);
    expect((await fetchWithSession("/api/local-data/x")).status).toBe(403);
    expect(replaced).toEqual(["/sign-in"]);
  });

  it("navigates nowhere when the refresh could not complete", async () => {
    // An unreachable network is not evidence that a session ended.
    const replaced = captureNavigation();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (calls.length === 1) return new Response(null, { status: 403 });
        throw new Error("offline");
      }),
    );
    const { fetchWithSession } = await freshDataClient();
    expect((await fetchWithSession("/api/local-data/x")).status).toBe(403);
    expect(replaced).toEqual([]);
  });
});
