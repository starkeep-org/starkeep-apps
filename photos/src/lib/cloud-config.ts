import type { CognitoConfig, STSCredentials } from "./cognito-auth";
import { fetchRuntimeConfig } from "./runtime-config";

export interface CloudConfig {
  stackPrefix: string;
  s3Bucket: string;
  s3Region: string;
  auroraEndpoint: string;
  apiGatewayUrl?: string;
  cognitoConfig: CognitoConfig;
  cognitoRefreshToken: string;
}

export interface CloudSetupState {
  state: "unconfigured" | "configured";
  has_credentials: boolean;
}

// Only Cognito tokens are session state — store them in localStorage.
// All infrastructure config (endpoints, Cognito pool IDs) comes from
// starkeep-runtime-config.json written by admin-web at install time.
const TOKENS_KEY = "starkeep:cloud-tokens";
const CREDENTIALS_KEY = "starkeep:cloud-credentials";

interface StoredTokens {
  cognitoRefreshToken: string;
}

function readStoredTokens(): StoredTokens | null {
  const raw = localStorage.getItem(TOKENS_KEY);
  if (raw) return JSON.parse(raw) as StoredTokens;
  // Backward compat: old code stored the full config here
  const legacyRaw = localStorage.getItem("starkeep:cloud-config");
  if (legacyRaw) {
    const legacy = JSON.parse(legacyRaw) as { cognitoRefreshToken?: string };
    if (legacy.cognitoRefreshToken) return { cognitoRefreshToken: legacy.cognitoRefreshToken };
  }
  return null;
}

export async function readCloudConfig(): Promise<CloudConfig | null> {
  const runtimeConfig = await fetchRuntimeConfig();
  if (!runtimeConfig?.apiGatewayUrl || !runtimeConfig.userPoolId || !runtimeConfig.userPoolClientId) return null;

  const tokens = readStoredTokens();
  if (!tokens?.cognitoRefreshToken) return null;

  const cognitoConfig: CognitoConfig = {
    region: runtimeConfig.region ?? "us-east-1",
    userPoolId: runtimeConfig.userPoolId,
    userPoolClientId: runtimeConfig.userPoolClientId,
    identityPoolId: runtimeConfig.identityPoolId ?? "",
  };

  return {
    stackPrefix: "",
    s3Bucket: runtimeConfig.s3Bucket ?? "",
    s3Region: runtimeConfig.s3Region ?? "us-east-1",
    auroraEndpoint: runtimeConfig.auroraEndpoint ?? "",
    apiGatewayUrl: runtimeConfig.apiGatewayUrl,
    cognitoConfig,
    cognitoRefreshToken: tokens.cognitoRefreshToken,
  };
}

export async function storeRefreshToken(refreshToken: string): Promise<void> {
  localStorage.setItem(TOKENS_KEY, JSON.stringify({ cognitoRefreshToken: refreshToken } satisfies StoredTokens));
}

// Kept for call-site compatibility — only the token is persisted now.
export async function writeCloudConfig(config: CloudConfig): Promise<void> {
  await storeRefreshToken(config.cognitoRefreshToken);
}

export async function readCloudCredentials(): Promise<STSCredentials | null> {
  const raw = localStorage.getItem(CREDENTIALS_KEY);
  return raw ? (JSON.parse(raw) as STSCredentials) : null;
}

export async function writeCloudCredentials(creds: STSCredentials): Promise<void> {
  localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(creds));
}

export async function getCloudSetupState(): Promise<CloudSetupState> {
  const config = await readCloudConfig();
  return {
    state: config ? "configured" : "unconfigured",
    has_credentials: !!config,
  };
}
