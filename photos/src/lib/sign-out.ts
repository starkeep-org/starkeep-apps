import { withBasePath } from "./base-path";

/**
 * End the browser's session, in the cloud build, the only build with one.
 *
 * The session lives in HttpOnly cookies, so only the server can end it. The
 * app's route clears them and names the platform's sign-out page, which ends
 * the managed login session too; without that visit the next "Sign in" would
 * skip the password.
 */
export async function signOut(): Promise<void> {
  const body = await fetch(withBasePath("/api/session/sign-out"), {
    method: "POST",
    credentials: "same-origin",
  })
    .then((r) => r.json() as Promise<{ signOutUrl?: string }>)
    .catch(() => ({}) as { signOutUrl?: string });
  if (body.signOutUrl) window.location.assign(body.signOutUrl);
  else window.location.reload();
}
