/**
 * Browser-side client for this machine's derivation switches.
 *
 * Through `withBasePath` and the session fetch, as `vision-client.ts` is. The
 * routes answer 501 in the cloud, where no sweep runs, and the UI reads that
 * as "not offered here" rather than as a failure.
 */

import { withBasePath } from "./base-path";
import { fetchWithSession } from "./data-client";

export interface DerivationConfigShape {
  derivePhotoStandIns: boolean;
  deriveVideoStandIns: boolean;
  downloadOriginalsToDerive: boolean;
}

export const DERIVATION_UNAVAILABLE = Symbol("derivation-unavailable");

async function answer(res: Response): Promise<DerivationConfigShape | typeof DERIVATION_UNAVAILABLE> {
  if (res.status === 501) return DERIVATION_UNAVAILABLE;
  const body = (await res.json().catch(() => ({}))) as {
    config?: DerivationConfigShape;
    error?: string;
    warning?: string;
  };
  if (!res.ok || !body.config) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  if (body.warning) console.warn(`[derivation] ${body.warning}`);
  return body.config;
}

export async function fetchDerivationConfig(): Promise<DerivationConfigShape | typeof DERIVATION_UNAVAILABLE> {
  return answer(await fetchWithSession(withBasePath("/api/derive/config")));
}

export async function updateDerivationConfig(
  patch: Partial<DerivationConfigShape>,
): Promise<DerivationConfigShape | typeof DERIVATION_UNAVAILABLE> {
  return answer(
    await fetchWithSession(withBasePath("/api/derive/config"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}
