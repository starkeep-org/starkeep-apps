import { getRuntimeConfig } from "@starkeep/app-client";

export const dynamic = "force-dynamic";

/**
 * The runtime config the browser reads, plus the one field Photos adds.
 *
 * The platform's handler covers what every app needs — the gateway URL, the
 * pool ids, the region. `lambdaConcurrency` is not that: it is the account's
 * invocation ceiling, and it is here because Photos is an app that fans out
 * invocations *on the user's behalf*, so its client is the thing that has to
 * size itself against the real number. Most apps have no such fan-out and no
 * use for it.
 *
 * Ten is the unraised account default, and the value comes from the operator's
 * `~/.starkeep/config.json` by way of the installer. A wrong number here is not
 * a crash: too low is a slower grid, too high is throttling that shows up as
 * tiles that never arrive.
 */
export function GET(): Response {
  const declared = Number(process.env.STARKEEP_LAMBDA_CONCURRENCY);
  return Response.json({
    ...getRuntimeConfig(),
    lambdaConcurrency: Number.isFinite(declared) && declared > 0 ? declared : 10,
  });
}
