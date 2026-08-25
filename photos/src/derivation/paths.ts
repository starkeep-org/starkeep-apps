/**
 * Where Photos keeps its on-device derivation state.
 *
 * `$STARKEEP_DIR/app-local/photos/derivation/` — the same non-syncing home the
 * vision state uses, and for the same reason it must be non-syncing here:
 *
 * A derivation attempt is a fact about *one node's capabilities* — "this
 * machine has no HEIC decoder" — and syncing it would let a phone's failure
 * tell the laptop not to bother with a file the laptop reads fine. That is the
 * exact inversion of what the cross-node fallback is for.
 *
 * The platform does not create, enumerate or clean up this directory, so an
 * uninstall leaves it behind. Losing it costs one wasted retry per record, never
 * a missing rendition.
 */

import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";

export function derivationDir(): string {
  return join(starkeepDir(), "app-local", "photos", "derivation");
}

/** What this node tried, and what came of it. Advisory. */
export function attemptsPath(): string {
  return join(derivationDir(), "attempts.json");
}

/** How far the resumable sweep has read, and what it is doing. */
export function sweepStatePath(): string {
  return join(derivationDir(), "sweep-state.json");
}
