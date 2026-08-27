"use client";

import React, { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { MediaPolicyKind, RenditionPolicies } from "@/photos-lib/rendition-policy";
import { RenditionResolutionCache, resolutionKey } from "@/lib/rendition-resolution-client";
import { setDerivationCompletedHandler } from "@/lib/on-demand-derivation";

const fallbackCache = new RenditionResolutionCache(null);
const ResolutionContext = createContext<RenditionResolutionCache>(fallbackCache);

export function RenditionResolutionProvider({
  policies,
  children,
}: {
  policies: RenditionPolicies | null;
  children: React.ReactNode;
}) {
  const cache = useMemo(() => new RenditionResolutionCache(policies), []);
  useEffect(() => cache.setPolicies(policies), [cache, policies]);
  useEffect(() => {
    setDerivationCompletedHandler(() => cache.refreshPending());
    return () => setDerivationCompletedHandler(null);
  }, [cache]);
  useEffect(() => () => cache.dispose(), [cache]);
  return <ResolutionContext.Provider value={cache}>{children}</ResolutionContext.Provider>;
}

export function useRenditionResolutionCache(): RenditionResolutionCache {
  return useContext(ResolutionContext);
}

export function useRenditionPolicy(kind: MediaPolicyKind) {
  const cache = useRenditionResolutionCache();
  return useSyncExternalStore(cache.subscribePolicy, () => cache.getPolicy(kind), () => cache.getPolicy(kind));
}

export function useMeasuredResolution(
  recordId: string,
  kind: MediaPolicyKind,
  requiredLongEdge: number | null,
  canonicalTargetLongEdge: number | null,
) {
  const cache = useRenditionResolutionCache();
  const policy = cache.getPolicy(kind);
  const key = policy && canonicalTargetLongEdge
    ? resolutionKey(recordId, policy.version, canonicalTargetLongEdge)
    : null;
  useEffect(() => {
    if (requiredLongEdge && canonicalTargetLongEdge) {
      cache.request(recordId, kind, requiredLongEdge, canonicalTargetLongEdge);
    }
  }, [cache, canonicalTargetLongEdge, kind, recordId, requiredLongEdge]);
  return useSyncExternalStore(
    (listener) => cache.subscribe(key, listener),
    () => cache.get(key),
    () => cache.get(key),
  );
}
