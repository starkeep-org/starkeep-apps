import type { OpenNextConfig } from "open-next/types/open-next.js";

export default {
  buildCommand: "next build",
  default: {
    override: {
      wrapper: "aws-lambda",
      converter: "aws-apigw-v2",
      // See infra/no-incremental-cache.ts — the default is S3, this
      // deployment gives it no bucket, and the failed round trips were on the
      // critical path of every SSR.
      incrementalCache: () => import("./infra/no-incremental-cache.js").then((m) => m.default),
    },
  },
} satisfies OpenNextConfig;

