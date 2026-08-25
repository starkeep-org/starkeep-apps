import { isRemoteDataTarget } from "../vision/remote";

/**
 * The guard both `/api/derive/*` routes run first.
 *
 * The sweep is a thread inside the long-lived local Next server, deriving from
 * bytes on the machine's own disk. A cloud-served Photos has neither — its
 * process is a request-scoped Lambda with a third of a core and thirty seconds,
 * and a whole-library sweep in that shape would time out having done and
 * discarded its work. Cloud derivation is on demand and bounded to what a
 * viewer is looking at, which is a different route entirely.
 *
 * 501 rather than 404, because the routes exist and the shape of the answer is
 * "not here" rather than "no such thing" — the same distinction, and the same
 * two independent signals, as the vision routes' guard.
 */
export function sweepNotAvailableRemotely(): Response | null {
  if (!isRemoteDataTarget()) return null;
  return Response.json(
    {
      error:
        "Library derivation runs only where the photo bytes live. In the cloud, " +
        "sizes are derived on demand for what is on screen.",
    },
    { status: 501 },
  );
}
