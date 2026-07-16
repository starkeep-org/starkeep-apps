import type { NextConfig } from "next";
import { resolve } from "path";

// When deployed under the shared API Gateway, the app is mounted at
// /apps/<appId>. The installer sets STARKEEP_APP_BASE_PATH at build time so
// Next emits all asset URLs and routes under that prefix. Unset in dev → "".
const basePath = process.env.STARKEEP_APP_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  basePath,
  turbopack: {
    // Anchor to this file, not the process cwd — the app can be launched from
    // outside the package dir (IDE runners, direct `next dev <dir>`).
    root: resolve(import.meta.dirname, ".."),
  },
  async rewrites() {
    return [
      {
        source: "/starkeep-runtime-config.json",
        destination: "/starkeep-runtime-config",
      },
    ];
  },
};

export default nextConfig;
