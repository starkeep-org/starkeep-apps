/**
 * What the phone's conditions actually are, rather than what they were assumed
 * to be.
 *
 * ## Why this exists
 *
 * `JOB_GRAPH` decides what may run from a {@link DeviceState}, and until now
 * every caller built that state from four hardcoded booleans labelled "assumed"
 * on the debug screen. Honest as a label and useless as an input: the one
 * constraint with a real cost attached — `push-blobs.requiresUnmetered`, which
 * is what stops a phone uploading a 4 GB video over cellular — was being
 * checked against the word `true`.
 *
 * Every reading here is taken fresh per tick rather than cached. Battery,
 * network and free space are exactly the things that change between two windows
 * the OS grants hours apart, and a state read once at launch would be a
 * different kind of fiction from the one it replaces.
 */

import { readPowerState, type PowerStateDeps } from "./power-state";
import type { DeviceState } from "./job-graph";

/**
 * The connection, as `expo-network` describes it.
 *
 * Narrowed to what this file consumes, so the module can be faked in Node like
 * everything else the tick depends on.
 */
export interface NetworkSnapshot {
  readonly type?: string | undefined;
  readonly isConnected?: boolean | undefined;
  readonly isInternetReachable?: boolean | undefined;
}

export interface NetworkDeps {
  getNetworkState(): Promise<NetworkSnapshot>;
}

/** Free and total bytes on the volume the node's data lives on. */
export interface DiskDeps {
  readDisk(): { readonly availableBytes: number; readonly totalBytes: number };
}

/**
 * The connection types treated as unmetered.
 *
 * **An inference, and the one approximation in this file.** Android decides
 * metering with `NetworkCapabilities.NOT_METERED`, which is what WorkManager
 * itself consults, and `expo-network` does not expose it — it reports a
 * connection *type* and nothing about its billing.
 *
 * Type is a good proxy and not the fact. It errs in the direction that costs
 * money exactly once: a metered Wi-Fi hotspot reads as unmetered here, and a
 * phone tethered to another phone would upload originals over somebody's data
 * plan. Nothing in JavaScript can close that gap.
 *
 * The native module Phase 2 needs for a MediaStore content trigger already
 * holds a `Context`, so `ConnectivityManager.isActiveNetworkMetered()` is one
 * method away once it exists. That is where this gets fixed rather than by
 * guessing harder here.
 */
const UNMETERED_TYPES = new Set(["WIFI", "ETHERNET"]);

/**
 * The fraction of the volume below which storage counts as low.
 *
 * WorkManager's own `requiresStorageNotLow` fires somewhere near 10% and is not
 * readable from JavaScript, so this names a threshold rather than inheriting
 * an invisible one. Matching the platform's rough figure keeps the two from
 * disagreeing about a phone the OS has already decided is full.
 */
export const STORAGE_LOW_FRACTION = 0.1;

export interface DeviceStateDeps {
  readonly network: NetworkDeps;
  readonly disk: DiskDeps;
  readonly power?: PowerStateDeps;
}

/**
 * Read every condition the job graph consults.
 *
 * Never throws. A tick that cannot read the battery must still run the jobs
 * that do not depend on it, and an exception here would take the whole window
 * with it. Each reading falls back to the conservative answer — no network,
 * metered, storage low — because every one of those defers work rather than
 * performing it on an unknown device, and deferred work costs one window.
 */
export async function readDeviceState(deps: DeviceStateDeps): Promise<DeviceState> {
  const base = {
    ...(await readNetwork(deps.network)),
    isStorageLow: readStorageLow(deps.disk),
  };
  return deps.power ? readPowerState(base, deps.power) : readPowerState(base);
}

async function readNetwork(
  deps: NetworkDeps,
): Promise<{ hasNetwork: boolean; isUnmetered: boolean }> {
  try {
    const state = await deps.getNetworkState();
    // `isInternetReachable` rather than `isConnected`: a phone attached to a
    // captive portal is connected to a network that cannot reach the cloud, and
    // a sync round against it spends a window discovering so.
    const hasNetwork = state.isInternetReachable ?? state.isConnected ?? false;
    return {
      hasNetwork,
      isUnmetered: hasNetwork && UNMETERED_TYPES.has(state.type ?? "UNKNOWN"),
    };
  } catch {
    return { hasNetwork: false, isUnmetered: false };
  }
}

function readStorageLow(deps: DiskDeps): boolean {
  try {
    const { availableBytes, totalBytes } = deps.readDisk();
    // A total of zero is a reading that failed rather than a full disk, and
    // treating it as full would stop eviction's own exemption from mattering.
    if (totalBytes <= 0) return true;
    return availableBytes / totalBytes < STORAGE_LOW_FRACTION;
  } catch {
    return true;
  }
}
