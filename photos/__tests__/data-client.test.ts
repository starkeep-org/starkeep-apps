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
 * reached directly on the gateway with the Cognito bearer token — that's
 * `resolveAppApiSource`, exercised separately below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable stand-ins the hoisted mocks read, so each test can set the scenario.
const runtimeConfig: { value: { apiGatewayUrl?: string } | null } = { value: null };
const cloudConfig: { value: unknown } = { value: null };
const cognito: { accessToken: string | null; throws: boolean } = {
  accessToken: null,
  throws: false,
};

vi.mock("../src/lib/runtime-config", () => ({
  fetchRuntimeConfig: vi.fn(async () => runtimeConfig.value),
}));
vi.mock("../src/lib/cloud-config", () => ({
  readCloudConfig: vi.fn(async () => cloudConfig.value),
}));
vi.mock("../src/lib/cognito-auth", () => ({
  refreshTokens: vi.fn(async () => {
    if (cognito.throws) throw new Error("refresh failed");
    return { accessToken: cognito.accessToken, expiresIn: 3600 };
  }),
}));

// data-client memoizes the target + token at module scope, so re-import fresh
// per test to isolate the local/remote decision.
async function freshDataClient() {
  vi.resetModules();
  return import("../src/lib/data-client");
}

const savedBasePath = process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH;

beforeEach(() => {
  runtimeConfig.value = null;
  cloudConfig.value = null;
  cognito.accessToken = null;
  cognito.throws = false;
  delete process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH;
});

afterEach(() => {
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
    cloudConfig.value = { cognitoConfig: {}, cognitoRefreshToken: "rt" };
    cognito.accessToken = "an-access-token";
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
    cloudConfig.value = { cognitoConfig: {}, cognitoRefreshToken: "rt" };
    cognito.accessToken = "an-access-token";
    const { resolveAppApiSource } = await freshDataClient();
    expect(await resolveAppApiSource()).toEqual({
      baseUrl: "https://api.example.com/apps/photos",
      headers: { Authorization: "Bearer an-access-token" },
    });
  });

  it("degrades to no auth header (rather than throwing) when the token can't be obtained", async () => {
    runtimeConfig.value = { apiGatewayUrl: "https://api.example.com" };
    cloudConfig.value = { cognitoConfig: {}, cognitoRefreshToken: "rt" };
    cognito.throws = true;
    const { resolveAppApiSource } = await freshDataClient();
    const source = await resolveAppApiSource();
    expect(source.baseUrl).toBe("https://api.example.com/apps/photos");
    expect(source.headers).toEqual({});
  });
});
