import { getRuntimeConfig } from "@starkeep/app-client";

/**
 * How long a browser may reuse this answer.
 *
 * Every field is a deployment fact — the gateway URL, the pool ids, the region,
 * the account's concurrency ceiling — identical for every caller and changed
 * only by an install, so `public` is honest and the browser should not refetch
 * it on each navigation. A minute bounds how long a reinstall's new values take
 * to reach an open tab, and `must-revalidate` forbids serving it stale past
 * that, which matters because a stale `apiGatewayUrl` points the client at a
 * gateway that no longer answers.
 *
 * CloudFront does not cache it either way: the distribution's default behavior
 * is `Managed-CachingDisabled` and this path is not one of the exceptions. This
 * header is for the browser.
 */
const CACHE_CONTROL = "public, max-age=60, must-revalidate";

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
  return Response.json(
    {
      ...getRuntimeConfig(),
      lambdaConcurrency: Number.isFinite(declared) && declared > 0 ? declared : 10,
    },
    { headers: { "cache-control": CACHE_CONTROL } },
  );
}
