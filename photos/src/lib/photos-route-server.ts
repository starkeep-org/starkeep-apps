import {
  loadAppCredentials,
  signedFetch,
  USER_TOKEN_HEADER,
  type SignedFetchInit,
} from "@starkeep/app-client";

export type AuthorizedPhotosFetch = {
  fetch: (path: string, init?: SignedFetchInit) => Promise<Response>;
  refreshedCookie?: string;
};

/**
 * Authenticate the browser before loading Photos' signing credential.
 *
 * A plain `Request`, not a framework request type. The platform's session
 * helpers read a method, a URL and headers, which is what every server half
 * Photos now has hands them: Hono's `c.req.raw` in the cloud and
 * `@hono/node-server`'s request locally are both the same `Request`.
 */
export async function authorizePhotosRoute(
  req: Request,
): Promise<AuthorizedPhotosFetch | Response> {
  const cloud = process.env.STARKEEP_APP_CLIENT_MODE === "cloud";
  let userToken: string | undefined;
  let refreshedCookie: string | undefined;
  if (cloud) {
    const { requireSession, mintIdToken } = await import("@starkeep/app-client/auth");
    if ((await requireSession(req)) === null) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }
    const minted = await mintIdToken(req, "photos");
    if (minted) {
      userToken = minted.token;
      refreshedCookie = minted.setCookie;
    }
  }

  const creds = await loadAppCredentials("photos");
  if (!creds) {
    return Response.json(
      { error: "photos has not been installed locally — run install from admin-web first" },
      { status: 503 },
    );
  }
  return {
    refreshedCookie,
    fetch: (path, init) => {
      return signedFetch(creds, path, {
        ...init,
        headers: {
          ...(userToken ? { [USER_TOKEN_HEADER]: userToken } : {}),
          ...init?.headers,
        },
      });
    },
  };
}

export function withRefreshedSession(response: Response, cookie?: string): Response {
  if (cookie) response.headers.append("Set-Cookie", cookie);
  return response;
}
