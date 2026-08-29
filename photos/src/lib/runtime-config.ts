import { withBasePath } from "./base-path";

export interface RuntimeConfig {
  region?: string;
  userPoolId?: string;
  userPoolClientId?: string;
  identityPoolId?: string;
  s3Bucket?: string;
  s3Region?: string;
  apiGatewayUrl?: string;
  auroraEndpoint?: string;
  photosWebUrl?: string;
  photosApiGatewayUrl?: string;
  /**
   * The account's Lambda invocation ceiling. See
   * `app/starkeep-runtime-config/route.ts` for why Photos carries it and most
   * apps do not.
   */
  lambdaConcurrency?: number;
}

let cached: RuntimeConfig | null | undefined = undefined;

export async function fetchRuntimeConfig(): Promise<RuntimeConfig | null> {
  if (cached !== undefined) return cached;
  try {
    // The route's own path, not the `.json` alias.
    //
    // The alias is a Next rewrite, which runs inside the Lambda — long after
    // the gateway has decided whether to admit the request. The manifest's
    // publicPaths and the CloudFront viewer function both name
    // `/starkeep-runtime-config`, so `/starkeep-runtime-config.json` is gated:
    // it answers 401 to a signed-out browser and costs a session-authorizer hop
    // to a signed-in one, for a payload that is pool identifiers the sign-in
    // page is meant to read before anyone has a session.
    const res = await fetch(withBasePath("/starkeep-runtime-config"));
    if (!res.ok) { cached = null; return null; }
    const json = await res.json() as RuntimeConfig;
    cached = json.apiGatewayUrl ? json : null;
    return cached;
  } catch {
    cached = null;
    return null;
  }
}
