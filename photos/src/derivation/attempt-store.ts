/**
 * `attempts.json` — what this node tried to derive, and what came of it.
 *
 * The one outcome that actually matters here is `undecodable-here`. Without it
 * persisted, a sweep re-downloads and re-fails on every HEIC in the library on
 * every pass, forever, and a phone-captured library is mostly HEIC. Everything
 * else the ledger records is a nicety by comparison.
 *
 * ## Advisory, and cheap to lose
 *
 * Deleting this file costs a wasted retry per record and nothing more, which is
 * also how a node that *gains* a decoder starts reading the files it used to
 * refuse. There is deliberately no invalidation logic for that case: an
 * operator installing a codec can delete a file, and inventing a capability
 * fingerprint to detect it automatically would be a lot of machinery guarding a
 * once-a-year event.
 *
 * ## One file, read whole
 *
 * A record per line or a SQLite table would both be defensible, but the working
 * set is one entry per *undecodable* record rather than per record, which for a
 * real library is hundreds rather than tens of thousands. Writes go through a
 * temp file and a rename so a process killed mid-write leaves the previous
 * version rather than a truncated one.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  DerivationAttempt,
} from "@/photos-lib/image-processing/derivation-attempts";
import type { DerivationAttemptStore } from "@/photos-lib/image-processing/derive-and-publish";
import { attemptsPath } from "./paths";

type Ledger = Record<string, DerivationAttempt>;

function readLedger(): Ledger {
  try {
    return JSON.parse(readFileSync(attemptsPath(), "utf-8")) as Ledger;
  } catch {
    return {};
  }
}

function writeLedger(ledger: Ledger): void {
  const path = attemptsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

/**
 * The store the Next server and its derivation worker share.
 *
 * Held behind a `Symbol.for` global rather than a module-level binding for the
 * same reason the vision scan controller is: `pnpm dev` re-evaluates the module
 * on every hot reload, and two in-memory copies of a file-backed ledger drift
 * apart between writes.
 */
const LEDGER_KEY = Symbol.for("starkeep.photos.derivation.attempts");

interface Cache {
  ledger: Ledger;
}

function cache(): Cache {
  const globals = globalThis as unknown as Record<symbol, Cache | undefined>;
  const existing = globals[LEDGER_KEY];
  if (existing) return existing;
  const created: Cache = { ledger: readLedger() };
  globals[LEDGER_KEY] = created;
  return created;
}

export function fileAttemptStore(): DerivationAttemptStore {
  return {
    async read(recordId: string): Promise<DerivationAttempt | null> {
      return cache().ledger[recordId] ?? null;
    },
    async write(attempt: DerivationAttempt): Promise<void> {
      const self = cache();
      // A `complete` outcome carries no information a later run needs — the
      // rendition query is the authority on what exists — so it is dropped
      // rather than stored. That keeps the file proportional to the number of
      // *problem* records instead of to the size of the library.
      if (attempt.outcome === "complete") {
        if (!(attempt.recordId in self.ledger)) return;
        delete self.ledger[attempt.recordId];
      } else {
        self.ledger[attempt.recordId] = attempt;
      }
      writeLedger(self.ledger);
    },
  };
}

/** Every verdict this node holds, for the sweep and the status surface. */
export function allAttempts(): ReadonlyMap<string, DerivationAttempt> {
  return new Map(Object.entries(cache().ledger));
}

/** Forget one verdict — how a node that gained a decoder retries a record. */
export function clearAttempt(recordId: string): void {
  const self = cache();
  if (!(recordId in self.ledger)) return;
  delete self.ledger[recordId];
  writeLedger(self.ledger);
}
