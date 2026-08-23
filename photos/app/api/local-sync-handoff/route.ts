import { loadAppCredentials, signedFetch } from "@starkeep/app-client";
import { SESSION_COOKIE, mintIdToken, readCookie } from "@starkeep/app-client/auth";

export const dynamic = "force-dynamic";

/**
 * Local surface only: hand the sync daemon the tokens it needs.
 *
 * The daemon is a separate process that signs its own outbound calls and
 * refreshes its own credentials on a timer, so it needs both the ID token and
 * the refresh token — `startOrKickSupervisor` refuses to run without a live
 * one. Before the session layer the browser held both and posted them itself.
 * It no longer holds either, which is the point, so the handoff moved here:
 * this route reads the two HttpOnly cookies server-side and forwards them over
 * the app's own HMAC-signed channel. The refresh token never re-enters the
 * page.
 *
 * This is app-owned rather than platform-owned on purpose. What happens after
 * sign-in is the app's business — Memo has no daemon handoff at all — and the
 * platform's session routes name no app and know nothing about a local daemon.
 *
 * Cloud mode has no daemon to hand anything to: there the server holds the
 * session and the sync supervisor runs on the user's own machine, not in the
 * Lambda. So this refuses outright rather than silently doing nothing.
 */
export async function POST(req: Request): Promise<Response> {
  if (process.env.STARKEEP_APP_CLIENT_MODE === "cloud") {
    return Response.json({ error: "No local daemon on the cloud surface" }, { status: 400 });
  }

  const minimal = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    text: () => req.text(),
    arrayBuffer: () => req.arrayBuffer(),
  };

  const refreshToken = readCookie(minimal, SESSION_COOKIE);
  const minted = await mintIdToken(minimal, "photos");
  if (!refreshToken || !minted) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const creds = await loadAppCredentials("photos");
  if (!creds) {
    return Response.json({ error: "photos is not installed locally" }, { status: 503 });
  }

  const body = JSON.stringify({ idToken: minted.token, refreshToken });
  const upstream = await signedFetch(creds, "/auth/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  const headers = new Headers({ "Content-Type": "application/json" });
  // A re-mint here still has to reach the browser, or the next request pays
  // for the same Cognito round trip.
  if (minted.setCookie) headers.append("Set-Cookie", minted.setCookie);
  return new Response(await upstream.text(), { status: upstream.status, headers });
}
