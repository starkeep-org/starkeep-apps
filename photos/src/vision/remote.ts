/**
 * The on-device guard every `/api/vision/*` route runs first.
 *
 * Face recognition is local-only, full stop (plan §3): no vision state on the
 * sync plane, no biometric data leaving the device, no cloud inference. A
 * cloud-served Photos has no `app-local/` directory to read, no models, and no
 * business running inference on someone else's hardware — so these routes
 * answer 501 there rather than 404 or an empty result, which would read as
 * "nothing found yet".
 *
 * Two independent signals, because either one alone is a single point of
 * failure:
 *   - `STARKEEP_APP_CLIENT_MODE=cloud` is what @starkeep/app-client itself uses
 *     to decide it is signing for a remote data server — the literal condition
 *     the plan names;
 *   - `NEXT_PUBLIC_FORCE_REMOTE` is baked in by `infra/build-bundle.ts`, so a
 *     cloud *build* refuses even if its runtime env is misconfigured.
 */

export function isRemoteDataTarget(): boolean {
  return (
    process.env.STARKEEP_APP_CLIENT_MODE === "cloud" ||
    process.env.NEXT_PUBLIC_FORCE_REMOTE === "true"
  );
}

/** The 501 body, or null when the request may proceed. */
export function remoteNotImplemented(): Response | null {
  if (!isRemoteDataTarget()) return null;
  return Response.json(
    {
      error:
        "On-device face recognition is not available against a remote data server — " +
        "it runs only where the photos and the models live.",
    },
    { status: 501 },
  );
}
