/**
 * Read/write `app-local/photos/derivation/config.json`: this machine's three
 * derivation switches.
 *
 * Photos' settings rather than the platform's: Photos is the only app that
 * derives stand-ins, and the platform could not enforce a switch for work an
 * app does. They govern the background sweep only. A resize a viewer asks for,
 * for the photograph on screen, runs with every switch off.
 *
 * Reads never throw, for the reason `vision/config.ts` gives: a corrupt file is
 * the default config, so the panel that fixes it can still render.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { derivationConfigPath } from "./paths";

export interface DerivationConfig {
  /**
   * Derive still stand-ins, and fill in each photo's dimensions and
   * placeholder, which need the same decode.
   */
  readonly derivePhotoStandIns: boolean;
  /** Derive posters, skims and video transcodes. */
  readonly deriveVideoStandIns: boolean;
  /**
   * Let the sweep read an original this machine does not hold, which downloads
   * it and keeps it until "Free up space". Off, the sweep reads only originals
   * already here. Meaningless while both derive switches are off.
   */
  readonly downloadOriginalsToDerive: boolean;
}

/**
 * A desktop's defaults. A phone derives its own photographs in full, so what a
 * desktop still downloads to derive is videos, cloud uploads, and Drive
 * uploads from machines without Photos.
 */
export const DEFAULT_DERIVATION_CONFIG: DerivationConfig = {
  derivePhotoStandIns: true,
  deriveVideoStandIns: true,
  downloadOriginalsToDerive: true,
};

export function mergeDerivationConfig(base: DerivationConfig, patch: unknown): DerivationConfig {
  const p = (patch ?? {}) as Partial<Record<keyof DerivationConfig, unknown>>;
  const pick = (key: keyof DerivationConfig) => (typeof p[key] === "boolean" ? (p[key] as boolean) : base[key]);
  return {
    derivePhotoStandIns: pick("derivePhotoStandIns"),
    deriveVideoStandIns: pick("deriveVideoStandIns"),
    downloadOriginalsToDerive: pick("downloadOriginalsToDerive"),
  };
}

/** Whether a pass may fetch an original at all. */
export function mayDownloadOriginals(config: DerivationConfig): boolean {
  return config.downloadOriginalsToDerive && (config.derivePhotoStandIns || config.deriveVideoStandIns);
}

export function readDerivationConfig(): DerivationConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(derivationConfigPath(), "utf-8"));
  } catch {
    return DEFAULT_DERIVATION_CONFIG;
  }
  return mergeDerivationConfig(DEFAULT_DERIVATION_CONFIG, raw);
}

export function writeDerivationConfig(config: DerivationConfig): void {
  const path = derivationConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}
