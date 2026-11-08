/**
 * The two checks Photos' local server makes before it routes a request.
 *
 * Local data carries no sign-in gate, which is safe only while whoever reaches
 * this server is the person at this machine. The loopback bind in `serve.ts`
 * keeps other devices out. These checks keep out other pages in this machine's
 * own browser, which can reach 127.0.0.1 as easily as Photos' own page can.
 */
import type { IncomingMessage } from "node:http";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The `Host` check keeps out a DNS-rebinding page, the same way the local data
 * server does; starkeep-core's `apps/local-data-server/loopback-host.ts`
 * explains why. A request with no `Host` did not come from a browser and
 * passes.
 */
function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return true;
  const lower = host.trim().toLowerCase();
  const end = lower.startsWith("[") ? lower.indexOf("]") + 1 : lower.indexOf(":");
  return LOOPBACK_HOSTNAMES.has(end > 0 ? lower.slice(0, end) : lower);
}

/**
 * The `Host` check does not stop a page on another site from sending Photos a
 * blind `no-cors` POST to `127.0.0.1`: its `Host` is loopback, and a
 * `text/plain` body needs no preflight. The signing proxy and every route of
 * Photos' own would sign it, and an app-table POST is an upsert, so such a page
 * could overwrite Photos' rows. `Sec-Fetch-Site` is the browser's verdict on
 * where the request came from. `same-site` counts as another site, because
 * every port on one loopback address is one site. A request without the header
 * came from no browser page and passes.
 *
 * A `GET` or `HEAD` navigation from another site passes, so admin-web's Open
 * link still works: following a link writes nothing, and the page that sent
 * the browser here cannot read the answer. A form POST is a navigation too,
 * and it is refused.
 */
function fromAnotherSite(req: Pick<IncomingMessage, "headers" | "method">): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site !== "cross-site" && site !== "same-site") return false;
  const followsLink =
    req.headers["sec-fetch-mode"] === "navigate" && (req.method === "GET" || req.method === "HEAD");
  return !followsLink;
}

/** Why Photos refuses this request, or null when it may be routed. */
export function localRefusal(req: Pick<IncomingMessage, "headers" | "method">): string | null {
  if (!isLoopbackHost(req.headers.host)) return "Photos answers on its loopback address only";
  if (fromAnotherSite(req)) return "Photos refuses requests from other sites";
  return null;
}
