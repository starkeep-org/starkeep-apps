import { sweepNotAvailableRemotely } from "@/derivation/remote";
import {
  mergeDerivationConfig,
  readDerivationConfig,
  writeDerivationConfig,
  type DerivationConfig,
} from "@/derivation/config";
import { startSweep } from "@/derivation/sweep-controller";

/** GET|PUT /api/derive/config — this machine's derivation switches. */
export async function GET(): Promise<Response> {
  const remote = sweepNotAvailableRemotely();
  if (remote) return remote;
  return Response.json({ config: readDerivationConfig() });
}

export async function PUT(req: Request): Promise<Response> {
  const remote = sweepNotAvailableRemotely();
  if (remote) return remote;

  const patch = await req.json().catch(() => null);
  const previous = readDerivationConfig();
  const next = mergeDerivationConfig(previous, patch);
  writeDerivationConfig(next);

  // A switch turned on has work waiting now, not at the next kick. Turning a
  // switch off needs nothing: each pass reads the switches when it starts, and
  // a running pass finishes the record it is on.
  if (turnedOn(previous, next)) {
    const started = await startSweep();
    // A pass already running picks the switch up on its next pass; only a
    // sweep that could not start at all is worth a word.
    if (!started.ok && started.status !== 409) {
      return Response.json({ config: next, warning: started.error });
    }
  }
  return Response.json({ config: next });
}

function turnedOn(previous: DerivationConfig, next: DerivationConfig): boolean {
  return (Object.keys(next) as (keyof DerivationConfig)[]).some((key) => next[key] && !previous[key]);
}
