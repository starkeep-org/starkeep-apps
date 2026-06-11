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
}

let cached: RuntimeConfig | null | undefined = undefined;

export async function fetchRuntimeConfig(): Promise<RuntimeConfig | null> {
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(withBasePath("/starkeep-runtime-config.json"));
    if (!res.ok) { cached = null; return null; }
    const json = await res.json() as RuntimeConfig;
    cached = json.apiGatewayUrl ? json : null;
    return cached;
  } catch {
    cached = null;
    return null;
  }
}
