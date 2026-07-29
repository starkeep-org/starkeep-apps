import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRemoteDataTarget, remoteNotImplemented } from "@/vision/remote";

/**
 * The on-device guard.
 *
 * Face recognition runs only where the photos and the models live. A
 * cloud-served Photos has neither, so these routes must answer 501 rather than
 * an empty result — "no faces found" and "this build cannot look" are different
 * answers, and only one of them means the user should wait.
 */

const KEYS = ["STARKEEP_APP_CLIENT_MODE", "NEXT_PUBLIC_FORCE_REMOTE"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("isRemoteDataTarget", () => {
  it("is false for an ordinary local run", () => {
    expect(isRemoteDataTarget()).toBe(false);
    expect(remoteNotImplemented()).toBeNull();
  });

  it("is true when app-client is signing for a cloud data server", () => {
    // The literal condition: this is the env var @starkeep/app-client itself
    // reads to decide which data server it is talking to.
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    expect(isRemoteDataTarget()).toBe(true);
  });

  it("is true for a cloud build even if the runtime env is missing", () => {
    // Baked in by infra/build-bundle.ts. The second signal exists precisely so
    // a misconfigured Lambda still refuses.
    process.env.NEXT_PUBLIC_FORCE_REMOTE = "true";
    expect(isRemoteDataTarget()).toBe(true);
  });

  it("is not fooled by a non-'cloud' client mode", () => {
    process.env.STARKEEP_APP_CLIENT_MODE = "local";
    process.env.NEXT_PUBLIC_FORCE_REMOTE = "false";
    expect(isRemoteDataTarget()).toBe(false);
  });
});

describe("remoteNotImplemented", () => {
  it("answers 501, not 404 or an empty result", async () => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    const res = remoteNotImplemented();
    expect(res).not.toBeNull();
    expect(res!.status).toBe(501);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toMatch(/not available against a remote data server/);
  });
});
