import type { NextConfig } from "next";
import { resolve } from "path";

// When deployed under the shared API Gateway, the app is mounted at
// /apps/<appId>. The installer sets STARKEEP_APP_BASE_PATH at build time so
// Next emits all asset URLs and routes under that prefix. Unset in dev → "".
const basePath = process.env.STARKEEP_APP_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  basePath,
  // onnxruntime-node is a native module and must never be bundled. Nothing in
  // the route graph imports it — the vision engine is reached only from the
  // scan worker, which is started by absolute path — but declaring it external
  // means that if something ever does, the build fails loudly instead of
  // quietly dragging 270 MB into the cloud `static` Lambda. `sharp` is here for
  // the same reason and has been used server-side since the resize route.
  serverExternalPackages: ["onnxruntime-node", "sharp"],
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
