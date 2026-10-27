/**
 * Signing in on the cloud's managed login page, in the system browser.
 *
 * The phone never sees the password. It opens the page through the platform's
 * auth session (Custom Tabs on Android), which shows the real address and the
 * browser's password manager; the page handles a first sign-in's new password
 * and "Forgot password"; and the page returns a one-time code to this app's
 * scheme. The phone exchanges the code, with the PKCE verifier only it holds,
 * for the session.
 *
 * Everything with a side effect is a parameter, so the flow runs under Vitest.
 */

import { type AuthTokens, type MobileAuthConfig } from "@starkeep/protocol-primitives";
import { toBase64 } from "./attested-key";

/** Where the managed login page returns. Registered by Photos' manifest. */
export const CALLBACK_URL = "starkeep-photos://auth/callback";

/** What the system browser's auth session reports. */
export type AuthSessionResult = { readonly type: "success"; readonly url: string } | { readonly type: string };

export interface BrowserSignInDeps {
  /** Open `url` in an auth session that ends at `redirectUrl`. `WebBrowser.openAuthSessionAsync`. */
  openAuthSession(url: string, redirectUrl: string): Promise<AuthSessionResult>;
  randomBytes(count: number): Uint8Array;
  sha256(bytes: Uint8Array): Promise<Uint8Array>;
  fetch: typeof fetch;
}

/** The person closed the sign-in page. Not an error worth a message. */
export class SignInCancelledError extends Error {
  constructor() {
    super("Sign-in was cancelled");
    this.name = "SignInCancelledError";
  }
}

function base64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The query of a URL, by hand: React Native's URL does not parse every scheme. */
function queryOf(url: string): Map<string, string> {
  const out = new Map<string, string>();
  const q = url.indexOf("?");
  if (q < 0) return out;
  for (const part of url.slice(q + 1).split("#", 1)[0]!.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = decodeURIComponent((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, " "));
    const value = eq < 0 ? "" : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "));
    out.set(key, value);
  }
  return out;
}

function form(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/**
 * Sign in on the managed login page and return the session's tokens.
 *
 * Throws {@link SignInCancelledError} when the person closes the page, and an
 * error with the page's own reason when it refuses.
 */
export async function signInWithBrowser(auth: MobileAuthConfig, deps: BrowserSignInDeps): Promise<AuthTokens> {
  const verifier = base64Url(deps.randomBytes(32));
  const state = base64Url(deps.randomBytes(16));
  const challenge = base64Url(await deps.sha256(new TextEncoder().encode(verifier)));
  const authorize =
    `https://${auth.cognitoDomain}/oauth2/authorize?` +
    form({
      response_type: "code",
      client_id: auth.mobileClientId,
      redirect_uri: CALLBACK_URL,
      scope: "openid email",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

  const result = await deps.openAuthSession(authorize, CALLBACK_URL);
  if (result.type !== "success" || !("url" in result)) throw new SignInCancelledError();
  const query = queryOf(result.url);
  // A code returned for another sign-in attempt is refused, whoever sent it.
  if (query.get("state") !== state) throw new Error("The sign-in page answered for another sign-in. Try again.");
  const error = query.get("error");
  if (error) throw new Error(`Sign-in did not finish: ${query.get("error_description") ?? error}`);
  const code = query.get("code");
  if (!code) throw new Error("The sign-in page returned no code. Try again.");

  const res = await deps.fetch(`https://${auth.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "authorization_code",
      client_id: auth.mobileClientId,
      code,
      redirect_uri: CALLBACK_URL,
      code_verifier: verifier,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Sign-in could not be completed: ${String(body["error"] ?? res.status)}`);
  }
  const idToken = body["id_token"];
  const accessToken = body["access_token"];
  const refreshToken = body["refresh_token"];
  if (typeof idToken !== "string" || typeof accessToken !== "string" || typeof refreshToken !== "string") {
    throw new Error("The sign-in returned an incomplete session. Try again.");
  }
  return {
    idToken,
    accessToken,
    refreshToken,
    expiresIn: typeof body["expires_in"] === "number" ? body["expires_in"] : 900,
  };
}
