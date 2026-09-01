/**
 * What work the phone does, in what order, under what conditions (item 14).
 *
 * ## The constraints this encodes
 *
 * From the media plan, and applied to Android deliberately even though Android
 * would permit more, so that iOS is a port rather than a rewrite:
 *
 * 1. No sync round may be assumed to complete.
 * 2. No work item may assume more than a few seconds.
 * 3. Byte transfer is delegated to an OS-managed mechanism surviving app death.
 * 4. Nothing is scheduled that depends on the app being open.
 *
 * **There is no foreground service.** A phone asked to carry a 60k-item library
 * does it across many short windows over days, not in one run. Anything that
 * quietly assumes otherwise is a bug even when it works on a dev handset
 * plugged into a laptop — which is the environment where such an assumption is
 * least likely to be noticed.
 *
 * ## Why the graph is data rather than code
 *
 * WorkManager wants declarations: what to run, what it needs, what it depends
 * on. Expressing that as a table makes the *policy* testable without a device —
 * ordering, constraints, backoff and the "is this safe to abandon" property are
 * all decidable here, and only the binding needs hardware.
 */

/** Conditions the OS must satisfy before a job may run. */
export interface JobConstraints {
  /**
   * Requires an unmetered connection.
   *
   * True for anything moving originals. A phone that uploads a 4 GB video over
   * cellular has not done the user a favour, however correct the transfer was,
   * and metered-connection billing is the kind of harm no retry logic undoes.
   */
  readonly requiresUnmetered: boolean;
  readonly requiresNetwork: boolean;
  /**
   * Requires the device to be charging.
   *
   * Reserved for derivation, which is the only genuinely CPU-hungry work here.
   * Requiring it for sync would mean a phone that is never plugged in never
   * syncs, which is worse than a slightly emptier battery.
   */
  readonly requiresCharging: boolean;
  /**
   * Requires the device to have room.
   *
   * **True only for jobs that put bytes on this device**, which is a narrower
   * rule than it first appears and was corrected against a real handset. The
   * blanket version gated almost everything, and a Pixel at 97% full then did
   * nothing at all: import was refused, sync was refused, and the one job left
   * running was an eviction pass that freed nothing, because a phone's own
   * photographs are aliases to the camera roll and cost the budget nothing to
   * begin with.
   *
   * That is exactly backwards. A phone that is full is the phone whose
   * photographs most need to be somewhere else, and the work that gets them
   * there — noticing them, and sending them — writes rows measured in bytes
   * and no blobs at all. Sending a blob to S3 consumes no local space
   * whatsoever.
   *
   * So the floor belongs on `fetch-blobs` and on derivation, which are the jobs
   * that actually land bytes here, and eviction stays exempt because it is what
   * fixes the condition. One gap remains and is deliberate: `MobileNode.sync()`
   * moves both directions, so a round can still pull a blob on a device with
   * little room. The residency budget bounds that, the foreground "Sync now"
   * button has never had a floor either, and the real repair is the same split
   * the metered constraint needs — a push-only round, expressed in the engine.
   */
  readonly requiresStorageNotLow: boolean;
}

export type JobId =
  /** One metadata exchange round. Small, frequent, cheap. */
  | "sync-metadata"
  /** Find records this node wants bytes for and has none of. */
  | "scan-acquirable"
  /** Fetch blobs residency says this node wants. */
  | "fetch-blobs"
  /** Push local blobs the cloud does not have. */
  | "push-blobs"
  /**
   * Derive the rungs a phone should produce whatever its power state.
   *
   * Split from the expensive rungs rather than given a battery *field*, because
   * {@link JobConstraints} is a fixed set of booleans and the two halves differ
   * in more than one of them anyway — including their unit budget. Splitting
   * also mirrors how the desktop sweep stages, which is not a coincidence: the
   * reason is the same on both, that the cheap rungs are what make a library
   * legible and the expensive ones are what make it sharp.
   */
  | "derive-ladder-cheap"
  /** The rungs above `image-medium`, which are a real CPU cost. */
  | "derive-ladder-full"
  /** Drop blobs the budget no longer allows. */
  | "evict"
  /** Observe MediaStore for new captures. */
  | "scan-media-store";

export interface JobSpec {
  readonly id: JobId;
  /** Human-readable, for the debug screen. */
  readonly description: string;
  readonly constraints: JobConstraints;
  /**
   * Roughly how long one unit of this job should take.
   *
   * Not a timeout — a budget for sizing the unit. Anything whose natural unit
   * exceeds a few seconds has to be split, because the OS decides when the app
   * stops and a unit that cannot finish in its window never finishes at all.
   */
  readonly targetSecondsPerUnit: number;
  /**
   * Whether abandoning this job midway is safe.
   *
   * Every job here must be, and the type exists to make an exception visible
   * rather than to permit one — a job that is unsafe to abandon cannot be
   * scheduled under constraint 1 at all, so this is an assertion the tests
   * check rather than a knob.
   */
  readonly resumable: true;
  /** Jobs that should have run first. Advisory ordering, not a hard barrier. */
  readonly after: readonly JobId[];
  /**
   * Whether the OS should carry the bytes rather than the app.
   *
   * Constraint 3. A transfer the app performs itself dies when the app does,
   * which on a phone is constantly — so large transfers are handed to a
   * download/upload manager that survives it.
   */
  readonly delegatedTransfer: boolean;
}

const NO_NETWORK: JobConstraints = {
  requiresUnmetered: false,
  requiresNetwork: false,
  requiresCharging: false,
  // Exempt from the storage floor, along with everything else here that does
  // not acquire bytes. See {@link JobConstraints.requiresStorageNotLow}.
  requiresStorageNotLow: false,
};

export const JOB_GRAPH: readonly JobSpec[] = [
  {
    id: "scan-media-store",
    description: "Notice photos and videos the camera has taken",
    // No network at all: this reads a local content provider. Requiring
    // connectivity would mean a phone in airplane mode forgets what it shot.
    constraints: NO_NETWORK,
    targetSecondsPerUnit: 2,
    resumable: true,
    after: [],
    delegatedTransfer: false,
  },
  {
    id: "sync-metadata",
    description: "Exchange records and labels with the cloud",
    constraints: {
      requiresUnmetered: false,
      requiresNetwork: true,
      requiresCharging: false,
      // Rows, not blobs. A library that stays browsable on a full phone is
      // worth a few kilobytes of them.
      requiresStorageNotLow: false,
    },
    // Metadata is small, so this runs on cellular deliberately: the library
    // staying browsable is worth a few kilobytes, and it is what makes elided
    // records visible at all.
    targetSecondsPerUnit: 5,
    resumable: true,
    after: [],
    delegatedTransfer: false,
  },
  {
    id: "derive-ladder-cheap",
    description: "Make the sizes the library needs to be viewable at all",
    constraints: {
      requiresUnmetered: false,
      requiresNetwork: false,
      // **Exempt from charging, deliberately.** Gating these on a charger would
      // mean a phone that is rarely plugged in shows a grid of placeholders for
      // its own camera roll — and it would gate more than the grid, because
      // `image-medium` is the rung on-device AI reads, so every model on the
      // phone would wait for a cable too.
      //
      // The exemption reaches up through `image-medium`, not just the two
      // bottom rungs, so this tier costs meaningfully more than a thumbnail —
      // but still comfortably inside the unit budget below.
      //
      // It also makes the output codec load-bearing rather than optional for
      // whoever binds this. AVIF costs three to ten times JPEG to encode, and a
      // rung that now runs on battery is exactly the rung that should be
      // allowed to produce a bigger, cheaper file rather than produce nothing.
      requiresCharging: false,
      requiresStorageNotLow: true,
    },
    targetSecondsPerUnit: 10,
    resumable: true,
    // Derivation reads what the scan found. Ordering is advisory rather than a
    // barrier: a scan that has not run yet simply means there is nothing to
    // derive, which is not a reason to block.
    after: ["scan-media-store"],
    delegatedTransfer: false,
  },
  {
    id: "derive-ladder-full",
    description: "Make the larger sizes, when power allows",
    constraints: {
      requiresUnmetered: false,
      requiresNetwork: false,
      // Not `requiresCharging`. The rule is "charging **or** comfortably above
      // half battery", and WorkManager cannot express that: it offers
      // `setRequiresCharging` and `setRequiresBatteryNotLow`, and the latter
      // fires somewhere near 15–20% rather than at a level the caller picks.
      //
      // So the OS constraint is the loose one and the real threshold is
      // re-checked in-process at the start of each unit — see
      // {@link FULL_DERIVE_BATTERY_FLOOR} and {@link fullDeriveMayRun}. A job
      // that declared `requiresCharging` here would simply never run on a phone
      // that lives off a charger, which is most of them.
      requiresCharging: false,
      requiresStorageNotLow: true,
    },
    // Shorter than the cheap tier's, and that is not a typo. These rungs are
    // individually more expensive, so the unit has to be *smaller* to fit the
    // same window — one rung of one photo rather than a record's whole cheap
    // tier.
    targetSecondsPerUnit: 5,
    resumable: true,
    // After the cheap tier, for the same reason the desktop sweep stages: the
    // library becoming legible everywhere beats one photo becoming sharp.
    after: ["derive-ladder-cheap"],
    delegatedTransfer: false,
  },
  {
    id: "push-blobs",
    description: "Upload local originals and renditions the cloud lacks",
    constraints: {
      requiresUnmetered: true,
      requiresNetwork: true,
      requiresCharging: false,
      // **Deliberately exempt.** Uploading consumes no local space, and a full
      // phone is the one whose photographs most need to be off it. Gating this
      // on free space made backup stop exactly when it mattered most.
      requiresStorageNotLow: false,
    },
    targetSecondsPerUnit: 5,
    resumable: true,
    // Renditions before originals is the rule, and derivation is what produces
    // them — pushing first would send a 40 MB original where a 130 KB
    // rendition would have done.
    after: ["derive-ladder-cheap", "sync-metadata"],
    delegatedTransfer: true,
  },
  {
    id: "scan-acquirable",
    description: "Find records this device wants bytes for and does not have",
    // No network: this is a walk over the local catalogue joined against the
    // local resident set. It is the correctness half of the acquisition queue —
    // the only thing that can find a library that landed before the queue
    // existed, a blob this device evicted, bytes that went away locally, or
    // everything a raised budget newly affords — and none of those questions
    // needs the cloud to answer.
    constraints: NO_NETWORK,
    // A page of the catalogue per unit, resumed from a cursor. A 60k-item
    // library is not a few seconds' work and is not attempted as such.
    targetSecondsPerUnit: 2,
    resumable: true,
    // Scanning against a stale catalogue finds a stale set. Advisory, as
    // everywhere here: a scan that runs first simply finds less.
    after: ["sync-metadata"],
    delegatedTransfer: false,
  },
  {
    id: "fetch-blobs",
    description: "Download the bytes residency says this node wants",
    constraints: {
      requiresUnmetered: true,
      requiresNetwork: true,
      requiresCharging: false,
      requiresStorageNotLow: true,
    },
    targetSecondsPerUnit: 5,
    resumable: true,
    // Fetching before the metadata round would be fetching against a stale idea
    // of what exists — and before the scan, against a stale idea of what is
    // missing. The queue this job drains is written by both of them.
    after: ["sync-metadata", "scan-acquirable"],
    delegatedTransfer: true,
  },
  {
    id: "evict",
    description: "Drop blobs the budget no longer allows",
    constraints: {
      requiresUnmetered: false,
      requiresNetwork: false,
      requiresCharging: false,
      // The one job exempt from the storage floor, because it is what fixes it.
      // Gating eviction on free space is a deadlock: the phone fills up and
      // then cannot run the job that would empty it.
      requiresStorageNotLow: false,
    },
    targetSecondsPerUnit: 2,
    resumable: true,
    // Eviction must know what is durable elsewhere before dropping anything,
    // and that is what the metadata round establishes.
    after: ["sync-metadata"],
    delegatedTransfer: false,
  },
];

export function jobSpec(id: JobId): JobSpec {
  const found = JOB_GRAPH.find((j) => j.id === id);
  if (!found) throw new Error(`unknown job: ${id}`);
  return found;
}

/**
 * A run order that respects every `after`.
 *
 * Advisory: the result is the order to *prefer*, not a set of barriers. A job
 * whose predecessor has not run is still allowed to run — it will simply find
 * nothing to do — because a hard barrier means one stalled job stops the phone
 * making any progress at all, which under constraint 1 is the likeliest state.
 */
export function preferredOrder(): JobId[] {
  const ordered: JobId[] = [];
  const visiting = new Set<JobId>();

  const visit = (id: JobId): void => {
    if (ordered.includes(id)) return;
    // A cycle in a hand-written table is a mistake rather than a possibility to
    // support, but it must not hang the scheduler.
    if (visiting.has(id)) return;
    visiting.add(id);
    for (const dep of jobSpec(id).after) visit(dep);
    visiting.delete(id);
    ordered.push(id);
  };

  for (const job of JOB_GRAPH) visit(job.id);
  return ordered;
}

/**
 * Exponential backoff for a job that keeps failing.
 *
 * Capped, and the cap matters more than the curve: an uncapped backoff on a
 * phone that was offline for a week returns from that week with a retry delay
 * measured in days, so the first thing it does on regaining connectivity is
 * nothing.
 */
export const MIN_BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 60 * 60_000;

export function backoffMs(attempt: number): number {
  if (attempt <= 0) return 0;
  return Math.min(MIN_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/**
 * The battery level above which the expensive rungs may run unplugged.
 *
 * One constant, checked in one place, because it is a *runtime* threshold and
 * not a WorkManager constraint — the OS offers "charging" and "not low", and
 * "not low" fires somewhere near 15–20% rather than where anyone chose.
 *
 * Half is a judgement, not a measurement: high enough that a user who unplugs
 * at 60% and goes out does not watch derivation eat the afternoon, low enough
 * that a phone which idles in the 50s still makes progress. The cheap rungs are
 * exempt entirely, so nothing a person actually looks at waits on this.
 */
export const FULL_DERIVE_BATTERY_FLOOR = 0.5;

/** Device conditions, as the scheduler sees them. */
export interface DeviceState {
  readonly hasNetwork: boolean;
  readonly isUnmetered: boolean;
  readonly isCharging: boolean;
  readonly isStorageLow: boolean;
  /**
   * Battery charge, 0–1.
   *
   * Optional because only one job consults it, and a caller that cannot read
   * the level should not be forced to invent one. Absent is treated as "not
   * above the floor", which defers expensive work rather than performing it on
   * an unknown battery — the safe direction, since the work resumes for free
   * next time the phone is charged.
   */
  readonly batteryLevel?: number;
  /** The user explicitly asked the OS to conserve power. */
  readonly isLowPowerMode?: boolean;
}

/**
 * Whether the expensive rungs may run right now.
 *
 * Checked per unit rather than once per job, because a phone unplugged halfway
 * through a pass should stop at the next unit rather than finish the queue. The
 * job is resumable, so stopping costs nothing but the unit in flight.
 */
export function fullDeriveMayRun(device: DeviceState): boolean {
  if (device.isLowPowerMode) return false;
  if (device.isCharging) return true;
  return (device.batteryLevel ?? 0) > FULL_DERIVE_BATTERY_FLOOR;
}

/** Whether the OS conditions currently permit this job. */
export function canRun(spec: JobSpec, device: DeviceState): boolean {
  if (spec.constraints.requiresNetwork && !device.hasNetwork) return false;
  if (spec.constraints.requiresUnmetered && !device.isUnmetered) return false;
  if (spec.constraints.requiresCharging && !device.isCharging) return false;
  if (spec.constraints.requiresStorageNotLow && device.isStorageLow) return false;
  // The one condition WorkManager cannot express, applied here so the scheduler
  // and the unit loop agree on it rather than each having their own idea.
  if (spec.id === "derive-ladder-full" && !fullDeriveMayRun(device)) return false;
  return true;
}

/** Everything runnable right now, in preferred order. */
export function runnableJobs(device: DeviceState): JobId[] {
  return preferredOrder().filter((id) => canRun(jobSpec(id), device));
}
