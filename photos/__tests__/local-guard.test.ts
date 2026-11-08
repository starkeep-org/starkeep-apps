/**
 * The local server's two refusals: a `Host` that is not loopback, and a request
 * another site's page sent. `serve.ts` answers 403 with whatever `localRefusal`
 * returns and routes the request only on null.
 */
import { describe, expect, it } from "vitest";
import { localRefusal } from "@/local-guard";

const FROM_ANOTHER_SITE = "Photos refuses requests from other sites";

function req(method: string, headers: Record<string, string>) {
  return { method, headers: { host: "127.0.0.1:4100", ...headers } };
}

describe("the Host check", () => {
  it.each(["127.0.0.1:4100", "localhost:4100", "[::1]:4100", "LOCALHOST"])("passes %s", (host) => {
    expect(localRefusal(req("GET", { host }))).toBeNull();
  });

  it("refuses a rebound hostname", () => {
    expect(localRefusal(req("GET", { host: "attacker.example:4100" }))).toBe(
      "Photos answers on its loopback address only",
    );
  });

  it("passes a request with no Host, which no browser sent", () => {
    expect(localRefusal({ method: "GET", headers: {} })).toBeNull();
  });
});

describe("a request from another site's page", () => {
  it.each(["cross-site", "same-site"])("refuses a POST with Sec-Fetch-Site: %s", (site) => {
    const blind = req("POST", { "sec-fetch-site": site, "sec-fetch-mode": "no-cors" });
    expect(localRefusal(blind)).toBe(FROM_ANOTHER_SITE);
  });

  it("refuses a cross-site GET fetch, which is not a navigation", () => {
    const fetched = req("GET", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" });
    expect(localRefusal(fetched)).toBe(FROM_ANOTHER_SITE);
  });

  it("refuses a form POST from another site, although it is a navigation", () => {
    const form = req("POST", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" });
    expect(localRefusal(form)).toBe(FROM_ANOTHER_SITE);
  });

  it.each(["GET", "HEAD"])("passes a %s navigation from admin-web's Open link", (method) => {
    const link = req(method, { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" });
    expect(localRefusal(link)).toBeNull();
  });

  it.each(["same-origin", "none"])("passes Sec-Fetch-Site: %s", (site) => {
    const own = req("POST", { "sec-fetch-site": site, "sec-fetch-mode": "cors" });
    expect(localRefusal(own)).toBeNull();
  });

  it("passes a POST with no Sec-Fetch-Site, which no browser page sent", () => {
    expect(localRefusal(req("POST", {}))).toBeNull();
  });

  it("checks the Host first", () => {
    const both = req("POST", { host: "attacker.example", "sec-fetch-site": "cross-site" });
    expect(localRefusal(both)).toBe("Photos answers on its loopback address only");
  });
});
