/**
 * The public viewer's one request. The items route is the platform's, at the
 * deployment root, and the page sends it no credential.
 */
import { describe, expect, it, vi } from "vitest";
import { fetchPublicPage, itemsUrl, linkTokenOf, sizeFor } from "@/public/public-share-client";

const TOKEN = "abcdefghijklmnopqrstuv";

describe("the public viewer's request", () => {
  it("reads a well-formed token from the app-relative path only", () => {
    expect(linkTokenOf(`/p/${TOKEN}`)).toBe(TOKEN);
    expect(linkTokenOf(`/p/${TOKEN}/`)).toBe(TOKEN);
    expect(linkTokenOf(`/p/${TOKEN}/x`)).toBeNull();
    expect(linkTokenOf("/p/short")).toBeNull();
    expect(linkTokenOf(`/photo/${TOKEN}`)).toBeNull();
  });

  it("asks the deployment root, never Photos' mount", () => {
    vi.stubEnv("STARKEEP_APP_BASE_PATH", "/apps/photos");
    expect(itemsUrl(TOKEN, null)).toBe(`/public-shares/${TOKEN}/items`);
    expect(itemsUrl(TOKEN, "a b")).toBe(`/public-shares/${TOKEN}/items?cursor=a%20b`);
    vi.unstubAllEnvs();
  });

  it("sends no credential and tells expired from gone", async () => {
    const calls: RequestInit[] = [];
    const answer = (status: number, body: unknown = {}) =>
      (async (_url: string, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
    const page = { title: "Summer", items: [], nextCursor: null, truncated: false };
    expect(await fetchPublicPage(TOKEN, null, answer(200, page))).toEqual({ ok: true, page });
    expect(calls[0]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    expect(await fetchPublicPage(TOKEN, null, answer(410))).toEqual({ ok: false, reason: "expired" });
    expect(await fetchPublicPage(TOKEN, null, answer(404))).toEqual({ ok: false, reason: "gone" });
    expect(await fetchPublicPage(TOKEN, null, answer(503))).toEqual({ ok: false, reason: "failed" });
  });

  it("picks the smallest size that covers the box, or the largest there is", () => {
    const sizes = [
      { longEdge: 320, url: "a" },
      { longEdge: 1280, url: "b" },
      { longEdge: 2560, url: "c" },
    ];
    expect(sizeFor(sizes, 300)?.url).toBe("a");
    expect(sizeFor(sizes, 900)?.url).toBe("b");
    expect(sizeFor(sizes, 4000)?.url).toBe("c");
    expect(sizeFor([], 100)).toBeNull();
  });
});
