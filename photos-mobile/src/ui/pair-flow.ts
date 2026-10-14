/**
 * Scanning admin-web's pairing code, as a state machine the screen renders.
 *
 * Kept apart from the camera screen so the rules are testable without a
 * camera. The rules that matter:
 *
 * - **A scanned code is never used straight away.** The screen names the cloud
 *   the code points at and asks first. A code from anywhere but the owner's
 *   admin-web would send this phone's photos to someone else's server, and the
 *   host is the one thing a person can check.
 * - **A bad code is reported once, not once per frame.** The camera reports the
 *   same code many times a second while it stays in view.
 * - **Nothing is scanned while a code is being confirmed or connected.**
 */

import { parsePairingPayload, type DeviceCredential } from "../auth/device-key";

export type PairFlow =
  | { readonly kind: "scanning"; readonly problem: string | null; readonly lastRejected: string | null }
  | { readonly kind: "confirming"; readonly credential: DeviceCredential; readonly host: string }
  | { readonly kind: "connecting"; readonly credential: DeviceCredential; readonly host: string }
  | { readonly kind: "failed"; readonly message: string };

export type PairEvent =
  | { readonly type: "scanned"; readonly data: string }
  | { readonly type: "rescan" }
  | { readonly type: "connect" }
  | { readonly type: "failed"; readonly message: string };

export const PAIR_FLOW_START: PairFlow = { kind: "scanning", problem: null, lastRejected: null };

export function pairFlow(state: PairFlow, event: PairEvent): PairFlow {
  switch (event.type) {
    case "scanned": {
      if (state.kind !== "scanning") return state;
      if (event.data === state.lastRejected) return state;
      const parsed = parsePairingPayload(event.data);
      if (!parsed.ok) return { kind: "scanning", problem: parsed.reason, lastRejected: event.data };
      return { kind: "confirming", credential: parsed.credential, host: parsed.host };
    }
    case "rescan":
      return PAIR_FLOW_START;
    case "connect":
      return state.kind === "confirming"
        ? { kind: "connecting", credential: state.credential, host: state.host }
        : state;
    case "failed":
      return state.kind === "connecting" ? { kind: "failed", message: event.message } : state;
  }
}

/** Whether the camera should report codes in this state. */
export function isScanning(state: PairFlow): boolean {
  return state.kind === "scanning";
}
