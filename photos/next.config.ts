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
};

export default nextConfig;
