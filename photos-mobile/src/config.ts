/**
 * The bundled cloud configuration, read back on the device.
 *
 * Second file (with `platform.ts`) that imports a React Native module, and for
 * the same reason: `expo-constants` is the only way to see what `app.config.ts`
 * put in `extra`, and keeping that import here leaves the auth client itself
 * loadable in Node against a fake.
 */

import Constants from "expo-constants";

export interface CloudConfig {
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  readonly identityPoolId: string;
  /** Cloud data server base URL — CloudFront when present, gateway otherwise. */
  readonly baseUrl: string;
  /** Derived, never stored. See {@link regionFromUserPoolId}. */
  readonly region: string;
}

/**
 * AWS encodes the region into a user-pool id (`us-east-1_Xxxxx`), so the pool id
 * is the authoritative region marker. `admin-web` derives it the same way and
 * for the same reason: a separately-stored region can drift from where the
 * resources actually live, and this one cannot.
 */
export function regionFromUserPoolId(userPoolId: string): string {
  const parts = userPoolId.split("_");
  return parts.length > 1 ? parts[0] : "";
}

/** Null when this build was made on a machine with no Starkeep configured. */
export function loadCloudConfig(): CloudConfig | null {
  const extra = Constants.expoConfig?.extra as
    | { starkeep?: Omit<CloudConfig, "region"> | null }
    | undefined;
  const raw = extra?.starkeep;
  if (!raw?.userPoolId || !raw.userPoolClientId) return null;
  return { ...raw, region: regionFromUserPoolId(raw.userPoolId) };
}
