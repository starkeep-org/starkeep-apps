import { type AppCredentials, signRequest } from "./local-app-creds";

/**
 * Server-side HMAC-signed fetch to the local-data-server. Used by the photos
 * Next.js routes that mediate access to platform endpoints — keeps the HMAC
 * logic out of each individual route.
 *
 * The HMAC signs the empty string for GET/HEAD (matching the local-data-server's
 * `validateAppHmac`); for other methods it signs the request body as-is. Pass
 * the body as a string or Buffer; binary payloads must arrive as a Buffer so
 * the HMAC and the network bytes match.
 */
export async function signedFetch(
  creds: AppCredentials,
  path: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer | Uint8Array;
  },
): Promise<Response> {
  const method = init?.method ?? "GET";
  const bodyForSig =
    method === "GET" || method === "HEAD"
      ? ""
      : typeof init?.body === "string"
        ? init.body
        : init?.body
          ? Buffer.from(init.body).toString("binary")
          : "";
  const headers: Record<string, string> = {
    ...(init?.headers ?? {}),
    ...signRequest(creds, bodyForSig),
  };
  return fetch(`${creds.dataServerUrl}${path}`, {
    method,
    headers,
    body: init?.body as BodyInit | undefined,
  });
}
