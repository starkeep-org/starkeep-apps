import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Where the phone learns which Starkeep it belongs to.
 *
 * The handset needs three public identifiers to sign in — user pool, app
 * client, identity pool — plus the cloud's base URL. All four already exist in
 * `~/.starkeep/config.json`, written by the installer, and typing them into a
 * phone by hand is both tedious and a way to end up signing into a pool that no
 * longer exists.
 *
 * So they are read at bundle time and carried in `expo.extra`. Two things worth
 * being explicit about:
 *
 * - **Nothing secret is baked in.** A user-pool id and an app-client id are
 *   published to every browser that loads a hosted UI; they identify a pool,
 *   they do not authorise anything. The per-app HMAC secret, which *is* secret,
 *   is deliberately not here — and is the reason this app cannot yet reach the
 *   cloud data plane (see `src/ui/Home.tsx`).
 * - **Absence is a state, not a crash.** A build with no config on the machine
 *   still runs and says so, because "the app failed to start" and "this laptop
 *   has no cloud configured" are very different problems to be debugging with a
 *   phone in your hand.
 */

interface StarkeepFileConfig {
  userPoolId?: string;
  userPoolClientId?: string;
  identityPoolId?: string;
  apiGatewayUrl?: string;
  publicBaseUrl?: string;
}

function readStarkeepConfig(): StarkeepFileConfig | null {
  const path = process.env["STARKEEP_CONFIG"] ?? join(homedir(), ".starkeep", "config.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StarkeepFileConfig;
  } catch {
    return null;
  }
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const file = readStarkeepConfig();
  return {
    ...config,
    name: config.name ?? "Starkeep",
    slug: config.slug ?? "starkeep",
    extra: {
      ...config.extra,
      starkeep: file
        ? {
            userPoolId: file.userPoolId ?? "",
            userPoolClientId: file.userPoolClientId ?? "",
            identityPoolId: file.identityPoolId ?? "",
            // The browser-facing CloudFront domain when there is one, the raw
            // gateway otherwise — the same preference `admin-web`'s data client
            // makes, for the same reason.
            baseUrl: file.publicBaseUrl ?? file.apiGatewayUrl ?? "",
          }
        : null,
    },
  };
};
