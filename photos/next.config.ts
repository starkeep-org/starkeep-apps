import type { NextConfig } from "next";
import { resolve } from "path";

const nextConfig: NextConfig = {
  output: "export",
  turbopack: {
    // pnpm puts the virtual store (.pnpm/) at the workspace root, which is the
    // parent of this directory (starkeep-apps/).  Turbopack must include that
    // directory in its root so it can follow node_modules symlinks into .pnpm.
    root: resolve(".."),
  },
  webpack: (config) => {
    // Deduplicate React across workspace packages — prevents "Cannot read properties
    // of null (reading 'useContext')" during SSR prerendering of /_global-error, which
    // is the only page rendered server-side (main page uses ssr:false).
    config.resolve.alias = {
      ...config.resolve.alias,
      react: resolve("node_modules/react"),
      "react-dom": resolve("node_modules/react-dom"),
      "react/jsx-runtime": resolve("node_modules/react/jsx-runtime"),
    };
    return config;
  },
};

export default nextConfig;
