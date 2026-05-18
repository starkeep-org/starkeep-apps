#!/usr/bin/env tsx
/**
 * Local deploy/remove wrapper for starkeep photos infrastructure.
 *
 * Usage (from infra/):
 *   pnpm run local:deploy   — authenticates with Cognito and deploys photos stack
 *   pnpm run local:remove   — authenticates with Cognito and removes photos stack
 *
 * Reads ~/.starkeep/config.json ($STARKEEP_DATA_DIR/config.json). Written by
 * admin-web; must contain apiGatewayUrl, auroraEndpoint, and s3Bucket.
 *
 * Deploy is two-phase on first run:
 *   1. Deploy photos API lambda → get photosApiGatewayUrl
 *   2. Build photos-web frontend with that URL → redeploy with static server
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface StarkeepConfig {
  stage: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  // Core outputs — required for photos deploy
  apiGatewayUrl: string;
  auroraEndpoint: string;
  s3Bucket: string;
}

function regionFromUserPoolId(userPoolId: string): string {
  const parts = userPoolId.split("_");
  return parts.length > 1 ? parts[0] : "";
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const INFRA_DIR = resolve(SCRIPT_DIR, "..");
const PHOTOS_DIR = resolve(SCRIPT_DIR, "..", "..");
const STARKEEP_DATA_DIR = process.env.STARKEEP_DATA_DIR ?? join(homedir(), ".starkeep");
const CONFIG_PATH = join(STARKEEP_DATA_DIR, "config.json");
const SST_OUTPUTS_PATH = resolve(INFRA_DIR, ".sst", "outputs.json");
const WEB_ASSETS_PATH = resolve(INFRA_DIR, "src", "web-assets.json");

function loadConfig(): StarkeepConfig {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    console.error(`Error: ~/.starkeep/config.json not found at ${CONFIG_PATH}`);
    console.error("Ensure the core infrastructure has been deployed and ~/.starkeep/config.json");
    console.error("contains apiGatewayUrl, auroraEndpoint, and s3Bucket.");
    process.exit(1);
  }

  let cfg: StarkeepConfig;
  try {
    cfg = JSON.parse(raw) as StarkeepConfig;
  } catch {
    console.error("Error: ~/.starkeep/config.json is not valid JSON");
    process.exit(1);
  }

  const missing: string[] = [];
  if (!cfg.apiGatewayUrl) missing.push("apiGatewayUrl");
  if (!cfg.auroraEndpoint) missing.push("auroraEndpoint");
  if (!cfg.s3Bucket) missing.push("s3Bucket");
  if (missing.length > 0) {
    console.error(
      `Error: ~/.starkeep/config.json is missing required fields: ${missing.join(", ")}\n` +
      `These are written by the core deploy. Complete cloud setup in admin-web first.`,
    );
    process.exit(1);
  }

  return cfg;
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------

function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    if (hidden) {
      process.stdout.write(question);
      process.stdin.setRawMode?.(true);
      let value = "";
      process.stdin.resume();
      process.stdin.setEncoding("utf8");

      const onData = (char: string) => {
        if (char === "\n" || char === "\r" || char === "") {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          rl.close();
          resolve(value);
        } else if (char === "" || char === "\b") {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      };
      process.stdin.on("data", onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Cognito auth
// ---------------------------------------------------------------------------

async function authenticate(
  config: StarkeepConfig,
  email: string,
  password: string,
): Promise<string> {
  const { CognitoIdentityProviderClient, InitiateAuthCommand, RespondToAuthChallengeCommand } =
    await import("@aws-sdk/client-cognito-identity-provider");

  const client = new CognitoIdentityProviderClient({ region: region });

  const initResponse = await client.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: config.userPoolClientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  );

  if (initResponse.AuthenticationResult?.IdToken) {
    return initResponse.AuthenticationResult.IdToken;
  }

  if (initResponse.ChallengeName === "NEW_PASSWORD_REQUIRED") {
    console.log(
      "\nThis account requires a new password (first login). Please set a permanent password.",
    );
    const newPassword = await prompt("New password: ", true);
    const confirmPassword = await prompt("Confirm new password: ", true);
    if (newPassword !== confirmPassword) {
      console.error("Passwords do not match.");
      process.exit(1);
    }

    const challengeResponse = await client.send(
      new RespondToAuthChallengeCommand({
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        ClientId: config.userPoolClientId,
        Session: initResponse.Session,
        ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
      }),
    );

    const idToken = challengeResponse.AuthenticationResult?.IdToken;
    if (!idToken) throw new Error("No ID token returned after password challenge");
    return idToken;
  }

  throw new Error(`Unexpected Cognito challenge: ${initResponse.ChallengeName}`);
}

async function getSTSCredentials(
  config: StarkeepConfig,
  idToken: string,
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  const { CognitoIdentityClient, GetIdCommand, GetCredentialsForIdentityCommand } =
    await import("@aws-sdk/client-cognito-identity");

  const client = new CognitoIdentityClient({ region: region });
  const loginKey = `cognito-idp.${region}.amazonaws.com/${config.userPoolId}`;
  const logins = { [loginKey]: idToken };

  const idResponse = await client.send(
    new GetIdCommand({ IdentityPoolId: config.identityPoolId, Logins: logins }),
  );
  if (!idResponse.IdentityId) throw new Error("Failed to get Cognito Identity ID");

  const credsResponse = await client.send(
    new GetCredentialsForIdentityCommand({ IdentityId: idResponse.IdentityId, Logins: logins }),
  );

  const c = credsResponse.Credentials;
  if (!c?.AccessKeyId || !c.SecretKey || !c.SessionToken) {
    throw new Error("Incomplete credentials from Identity Pool");
  }

  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretKey,
    sessionToken: c.SessionToken,
  };
}

// ---------------------------------------------------------------------------
// Frontend build
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
};
const TEXT_EXTS = new Set([".html", ".js", ".css", ".json", ".map", ".svg", ".txt"]);

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) results.push(...walkDir(full));
    else results.push(full);
  }
  return results;
}

function buildPhotosWeb(config: StarkeepConfig, photosApiGatewayUrl: string): void {
  console.log("\nBuilding photos-web static export...");

  // Write the runtime config that the deployed app reads at startup.
  // apiGatewayUrl = core user-data gateway; photosApiGatewayUrl = photos-specific gateway.
  const runtimeConfig = {
    apiGatewayUrl: config.apiGatewayUrl,
    photosApiGatewayUrl,
    region: region,
    userPoolId: config.userPoolId,
    userPoolClientId: config.userPoolClientId,
    identityPoolId: config.identityPoolId,
    auroraEndpoint: config.auroraEndpoint,
    s3Bucket: config.s3Bucket,
    s3Region: region,
  };
  writeFileSync(
    resolve(PHOTOS_DIR, "public", "starkeep-runtime-config.json"),
    JSON.stringify(runtimeConfig, null, 2),
  );

  const buildResult = spawnSync("pnpm", ["build"], {
    stdio: "inherit",
    cwd: PHOTOS_DIR,
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_PUBLIC_FORCE_REMOTE: "true",
      NEXT_PUBLIC_API_GATEWAY_URL: photosApiGatewayUrl,
      NEXT_PUBLIC_COGNITO_REGION: region,
      NEXT_PUBLIC_COGNITO_USER_POOL_ID: config.userPoolId,
      NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID: config.userPoolClientId,
    },
  });
  if (buildResult.status !== 0) {
    console.error("photos-web build failed. Aborting deploy.");
    process.exit(buildResult.status ?? 1);
  }
  console.log("photos-web build complete.");

  const outDir = resolve(PHOTOS_DIR, "out");
  const assets: Record<string, { content: string; isBase64: boolean; contentType: string }> = {};
  for (const absPath of walkDir(outDir)) {
    const relPath = absPath.slice(outDir.length).replace(/\\/g, "/");
    const ext = extname(absPath).toLowerCase();
    const isText = TEXT_EXTS.has(ext);
    const buf = readFileSync(absPath);
    assets[relPath] = {
      content: isText ? buf.toString("utf-8") : buf.toString("base64"),
      isBase64: !isText,
      contentType: MIME[ext] ?? "application/octet-stream",
    };
  }
  writeFileSync(WEB_ASSETS_PATH, JSON.stringify(assets));
  console.log(`Generated web-assets.json (${Object.keys(assets).length} files)`);
}

// ---------------------------------------------------------------------------
// SST runner
// ---------------------------------------------------------------------------

function runSst(
  sstCommand: string,
  stage: string,
  creds: { accessKeyId: string; secretAccessKey: string; sessionToken: string },
): void {
  console.log(`\nRunning: sst ${sstCommand} --stage ${stage}\n`);
  const result = spawnSync(
    "node",
    ["./node_modules/sst/bin/sst.mjs", sstCommand, "--stage", stage],
    {
      stdio: "inherit",
      cwd: INFRA_DIR,
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: creds.accessKeyId,
        AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
        AWS_SESSION_TOKEN: creds.sessionToken,
        AWS_REGION: region,
      },
    },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const flags = process.argv.slice(2);
const command = flags.find((a) => !a.startsWith("--"));
const nonInteractive = flags.includes("--non-interactive");

if (command !== "deploy" && command !== "remove") {
  console.error("Usage: local-deploy.ts <deploy|remove> [--non-interactive]");
  process.exit(1);
}

const config = loadConfig();
const region = regionFromUserPoolId(config.userPoolId);

console.log(`\nStarkeep photos local ${command}`);
console.log(`  Region : ${region}`);
console.log(`  Stage  : ${config.stage}`);
console.log("");

let creds: { accessKeyId: string; secretAccessKey: string; sessionToken: string };

if (nonInteractive) {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_SESSION_TOKEN) {
    console.error("--non-interactive requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_SESSION_TOKEN env vars");
    process.exit(1);
  }
  creds = { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY, sessionToken: AWS_SESSION_TOKEN };
} else {
  const email = await prompt("Email: ");
  const password = await prompt("Password: ", true);

  console.log("\nAuthenticating...");
  let idToken: string;
  try {
    idToken = await authenticate(config, email, password);
  } catch (err) {
    console.error(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log("Getting temporary AWS credentials...");
  try {
    creds = await getSTSCredentials(config, idToken);
  } catch (err) {
    console.error(`Failed to get AWS credentials: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Preflight: verify the deploy-permissions stack exists.
if (command === "deploy") {
  const permissionsStackName = `${config.stage}-deploy-permissions`;
  console.log(`Checking deploy-permissions stack (${permissionsStackName})...`);
  const cfn = new CloudFormationClient({ region: region, credentials: creds });
  try {
    const resp = await cfn.send(
      new DescribeStacksCommand({ StackName: permissionsStackName }),
    );
    const phase = resp.Stacks?.[0]?.StackStatus ?? "UNKNOWN";
    if (
      phase !== "CREATE_COMPLETE" &&
      phase !== "UPDATE_COMPLETE" &&
      phase !== "UPDATE_ROLLBACK_COMPLETE"
    ) {
      console.error(
        `Error: deploy-permissions stack is in state ${phase}. Open admin-web -> Deploy permissions to fix.`,
      );
      process.exit(1);
    }
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e.name === "ValidationError" && e.message?.includes("does not exist")) {
      console.error(
        `Error: the deploy-permissions stack "${permissionsStackName}" does not exist.\n` +
          `\n` +
          `The bootstrap stack only grants enough permission to manage the deploy-permissions\n` +
          `stack — the actual SST deploy permissions live there. Create it from admin-web:\n` +
          `\n` +
          `  1. Open admin-web (pnpm --filter admin-web dev)\n` +
          `  2. Navigate to "Deploy permissions" in the sidebar\n` +
          `  3. Click "Create permissions stack"\n` +
          `\n` +
          `Then re-run this command.`,
      );
      process.exit(1);
    }
    console.error(
      `Failed to check deploy-permissions stack: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Check for a prior deploy to get the existing photosApiGatewayUrl.
  // If it exists, build the frontend now so the static-server Lambda is included this deploy.
  const photosCloudConfigPath = resolve(INFRA_DIR, "photos-cloud-config.json");
  let priorPhotosApiUrl: string | undefined;
  if (existsSync(photosCloudConfigPath)) {
    try {
      const prior = JSON.parse(readFileSync(photosCloudConfigPath, "utf-8")) as Record<string, unknown>;
      if (typeof prior.photosApiGatewayUrl === "string") {
        priorPhotosApiUrl = prior.photosApiGatewayUrl;
      }
    } catch { /* ignore */ }
  }

  if (priorPhotosApiUrl) {
    buildPhotosWeb(config, priorPhotosApiUrl);
  }

  runSst("deploy", config.stage, creds);

  // Read fresh outputs after deploy.
  let freshPhotosApiUrl: string | undefined;
  try {
    const outputs = JSON.parse(readFileSync(SST_OUTPUTS_PATH, "utf-8")) as Record<string, string>;
    if (outputs.photosApiGatewayUrl) freshPhotosApiUrl = outputs.photosApiGatewayUrl;
  } catch { /* ignore */ }

  // First-ever deploy: photosApiGatewayUrl is now available for the first time.
  // Build the frontend and redeploy so the static-server Lambda is included.
  if (!priorPhotosApiUrl && freshPhotosApiUrl) {
    console.log("\nphotosApiGatewayUrl is now available — building photos-web and re-deploying...");
    buildPhotosWeb(config, freshPhotosApiUrl);
    runSst("deploy", config.stage, creds);
  }
} else {
  runSst("remove", config.stage, creds);
}

process.exit(0);
