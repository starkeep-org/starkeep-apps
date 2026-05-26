import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Shared loader for the photos app's locally-installed credentials.
 * Read from `.starkeep-local.json` (written by admin-web at install time).
 * Used by every server route that talks to the local-data-server: the
 * /api/local-data proxy and /api/resize.
 */
export interface AppCredentials {
  appId: string;
  hmacSecret: string;
  dataServerUrl: string;
}

let cached: AppCredentials | null | undefined = undefined;

export function loadLocalAppCredentials(): AppCredentials | null {
  if (cached !== undefined) return cached;
  const candidate = resolve(process.cwd(), ".starkeep-local.json");
  if (!existsSync(candidate)) {
    cached = null;
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as Partial<AppCredentials>;
    if (!parsed.appId || !parsed.hmacSecret) {
      cached = null;
      return null;
    }
    cached = {
      appId: parsed.appId,
      hmacSecret: parsed.hmacSecret,
      dataServerUrl: parsed.dataServerUrl ?? "http://127.0.0.1:9820",
    };
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

export function signRequest(creds: AppCredentials, body: string): Record<string, string> {
  const sig = createHmac("sha256", creds.hmacSecret)
    .update(`${creds.appId}:${body}`)
    .digest("hex");
  return {
    "X-Starkeep-App-Id": creds.appId,
    "X-Starkeep-App-Sig": sig,
  };
}
