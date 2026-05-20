import type { NextConfig } from "next";
import { resolve } from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(".."),
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
