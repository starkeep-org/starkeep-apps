import type { OpenNextConfig } from "open-next/types/open-next.js";

export default {
  buildCommand: "next build",
  default: {
    override: {
      wrapper: "aws-lambda",
      converter: "aws-apigw-v2",
    },
  },
} satisfies OpenNextConfig;

