/**
 * Which background derivation pass may run on this device, and how.
 *
 * Separate from `platform.ts`, which reaches the native encoder, so that the
 * gate a person controls is testable where it takes effect: every background
 * pass — the one on app open, and both jobs in a background window — asks
 * here first.
 */

import type { MobileNode } from "../node";
import type { ScanCursorStore } from "../work/scan-cursor";
import { FULL_DERIVE_CEILING_LONG_EDGE } from "./derive-ladder";

export type BackgroundDerivePass = "cheap" | "full";

export interface BackgroundDerivePlan {
  readonly cursor: ScanCursorStore;
  /** Absent for the cheap pass, which keeps the sweep's standing ceiling. */
  readonly ceilingLongEdge?: number;
  readonly maxRecords?: number;
}

/**
 * The plan for one pass, or null when none may run: a device that reads no
 * camera roll, or one whose person turned photo derivation off. Null is the
 * same answer as a device that cannot derive, so a caller stops asking.
 */
export function backgroundDerivePlan(
  node: Pick<MobileNode, "derivationCursor" | "fullDerivationCursor" | "deviceSettings">,
  pass: BackgroundDerivePass,
  options: { readonly maxRecords?: number } = {},
): BackgroundDerivePlan | null {
  if (!node.deviceSettings().derivePhotoStandIns) return null;
  if (pass === "cheap") {
    if (!node.derivationCursor) return null;
    return {
      cursor: node.derivationCursor,
      ...(options.maxRecords !== undefined ? { maxRecords: options.maxRecords } : {}),
    };
  }
  if (!node.fullDerivationCursor) return null;
  return {
    cursor: node.fullDerivationCursor,
    ceilingLongEdge: FULL_DERIVE_CEILING_LONG_EDGE,
    // One decode per unit: these encodes are the expensive ones, and a window
    // must be able to stop between them.
    maxRecords: options.maxRecords ?? 1,
  };
}
