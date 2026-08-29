import type { OpenNextConfig } from "open-next/types/open-next.js";

export default {
  buildCommand: "next build",
  default: {
    override: {
      wrapper: "aws-lambda",
      converter: "aws-apigw-v2",
      // Both cache overrides exist for the same reason: OpenNext's defaults are
      // S3 and DynamoDB, this deployment provisions neither, and the failed
      // round trips sat on the critical path of every render. See
      // infra/prerender-cache.ts (which also serves the build's prerendered
      // pages instead of re-rendering them) and infra/no-tag-cache.ts.
      incrementalCache: () => import("./infra/prerender-cache.js").then((m) => m.default),
      tagCache: () => import("./infra/no-tag-cache.js").then((m) => m.default),
    },
  },
} satisfies OpenNextConfig;
