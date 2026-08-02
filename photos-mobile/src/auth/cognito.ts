/**
 * Signing in, over `fetch` rather than the AWS SDK.
 *
 * `admin-web` uses `@aws-sdk/client-cognito-identity-provider` for this and is
 * right to — it is a browser with a bundler that will not blink at a megabyte.
 * A React Native bundle is a different trade: the three calls this app makes
 * (`InitiateAuth`, `RespondToAuthChallenge`, refresh) are **unsigned** JSON
 * posts, so the SDK would be carried entirely for its request builder, along
 * with its Node-shaped dependencies and the polyfill hunt that follows.
 *
 * The cost of doing it by hand is that the wire format lives here: the target
 * header, the error envelope, the auth-parameter names. That is a small,
 * stable, documented surface, and it is fully exercisable in Node against a
 * fake `fetch` — which is the property that matters, since a phone is the worst
 * place to find out that a sign-in request was malformed.
 *
 * No AWS credentials are ever handled here. Identity-pool credentials (item 12b
 * proper, once there is something to authorise) are a separate exchange.
 */

export interface AuthTokens {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

/**
 * Either tokens, or a challenge that must be answered first.
 *
 * `NEW_PASSWORD_REQUIRED` is the expected first-sign-in state for a user the
 * installer created, so it is modelled rather than treated as an error — a
 * phone that says "incorrect password" to a password that is merely temporary
 * is unfixable from the phone.
 */
export type SignInResult =
  | { readonly kind: "tokens"; readonly tokens: AuthTokens }
  | { readonly kind: "new-password-required"; readonly session: string };

export interface CognitoClientOptions {
  readonly region: string;
  readonly userPoolClientId: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Cognito's error envelope: `{"__type": "NotAuthorizedException", "message": ...}`.
 *
 * `status` is carried because callers need to distinguish *the pool rejected
 * this credential* from *the pool did not answer* — a 4xx means the stored
 * refresh token is dead and should be discarded, while a 5xx means Cognito is
 * having a bad day and the token is very likely still good. Deciding that from
 * the message text would be guesswork; deciding it from a status code is not.
 *
 * Zero for errors raised here rather than by Cognito, which is deliberately not
 * in the 4xx band: a response this client failed to make sense of is not
 * evidence that the credential is bad.
 */
export class CognitoError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 0,
  ) {
    super(message);
    this.name = "CognitoError";
  }
}

interface AuthenticationResult {
  AccessToken?: string;
  IdToken?: string;
  RefreshToken?: string;
  ExpiresIn?: number;
}

interface AuthResponse {
  AuthenticationResult?: AuthenticationResult;
  ChallengeName?: string;
  Session?: string;
}

export interface CognitoClient {
  signIn(email: string, password: string): Promise<SignInResult>;
  /** Answer a `NEW_PASSWORD_REQUIRED` challenge. */
  setNewPassword(email: string, session: string, newPassword: string): Promise<AuthTokens>;
  /**
   * Exchange a stored refresh token for a live session.
   *
   * Cognito does not return the refresh token again, so the caller's stored one
   * remains authoritative — it is echoed back here so callers never have to know
   * that.
   */
  refresh(refreshToken: string): Promise<AuthTokens>;
}

export function createCognitoClient(options: CognitoClientOptions): CognitoClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = `https://cognito-idp.${options.region}.amazonaws.com/`;

  async function call(target: string, body: unknown): Promise<AuthResponse> {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      // `__type` arrives either bare or ARN-qualified depending on the error;
      // the tail is the part anyone matches on.
      const type = String(parsed["__type"] ?? "UnknownError");
      const code = type.slice(type.lastIndexOf("#") + 1);
      const message = String(parsed["message"] ?? parsed["Message"] ?? response.statusText);
      throw new CognitoError(code, message, response.status);
    }

    return parsed as AuthResponse;
  }

  function tokensFrom(result: AuthenticationResult | undefined, refreshToken?: string): AuthTokens {
    const refresh = result?.RefreshToken ?? refreshToken;
    if (!result?.AccessToken || !result.IdToken || !refresh) {
      throw new CognitoError("IncompleteAuthResult", "Cognito returned an incomplete session");
    }
    return {
      accessToken: result.AccessToken,
      idToken: result.IdToken,
      refreshToken: refresh,
      expiresIn: result.ExpiresIn ?? 3600,
    };
  }

  return {
    async signIn(email, password) {
      const response = await call("InitiateAuth", {
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: options.userPoolClientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      });

      if (response.AuthenticationResult) {
        return { kind: "tokens", tokens: tokensFrom(response.AuthenticationResult) };
      }
      if (response.ChallengeName === "NEW_PASSWORD_REQUIRED" && response.Session) {
        return { kind: "new-password-required", session: response.Session };
      }
      // MFA and the rest are real Cognito states this app cannot answer. Naming
      // the challenge beats "sign-in failed", which would send someone looking
      // at their password.
      throw new CognitoError(
        "UnsupportedChallenge",
        `Sign-in needs a challenge this app cannot answer: ${response.ChallengeName ?? "unknown"}`,
      );
    },

    async setNewPassword(email, session, newPassword) {
      const response = await call("RespondToAuthChallenge", {
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        ClientId: options.userPoolClientId,
        Session: session,
        ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
      });
      return tokensFrom(response.AuthenticationResult);
    },

    async refresh(refreshToken) {
      const response = await call("InitiateAuth", {
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: options.userPoolClientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      });
      return tokensFrom(response.AuthenticationResult, refreshToken);
    },
  };
}

/**
 * The email a session belongs to, from the id token's claims.
 *
 * Decoded, not verified — this is display text. The token's signature is what
 * the cloud checks; a phone re-checking it would be proving something to itself.
 *
 * Base64url is decoded by hand because `atob` is not something to bet a login
 * screen on across Hermes versions, and the alternative is a dependency.
 */
export function emailFromIdToken(idToken: string): string | null {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(decodeBase64Url(payload)) as { email?: string };
    return claims.email ?? null;
  } catch {
    return null;
  }
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of normalized) {
    if (char === "=") break;
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
