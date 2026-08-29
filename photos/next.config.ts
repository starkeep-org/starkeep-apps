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
  // No `/starkeep-runtime-config.json` rewrite. A rewrite runs inside the app,
  // after the gateway has already decided whether to admit the request, so the
  // alias could never be public the way the route it aliased is — the manifest
  // and the CloudFront viewer function both name `/starkeep-runtime-config`.
  // The client asks for that path directly (src/lib/runtime-config.ts).
};

export default nextConfig;
