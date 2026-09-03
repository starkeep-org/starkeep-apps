import { STILL_LADDER, VIDEO_LADDER } from "./ladder";

export type MediaPolicyKind = "still" | "video";

export interface RenditionThresholdPolicy {
  kind: MediaPolicyKind;
  version: string;
  targetLongEdges: number[];
}

export interface RenditionPolicies {
  still: RenditionThresholdPolicy;
  video: RenditionThresholdPolicy;
}

function semanticVersion(kind: MediaPolicyKind, targets: readonly number[]): string {
  const semantics = `${kind}:${targets.join(",")}`;
  let hash = 2166136261;
  for (let index = 0; index < semantics.length; index++) {
    hash ^= semantics.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${kind}-${(hash >>> 0).toString(36)}`;
}

function policy(kind: MediaPolicyKind, targets: readonly number[]): RenditionThresholdPolicy {
  const targetLongEdges = [...new Set(targets)].sort((a, b) => a - b);
  return { kind, version: semanticVersion(kind, targetLongEdges), targetLongEdges };
}

/** Server-owned browser selection boundaries, generated from canonical ladders. */
export function currentRenditionPolicies(): RenditionPolicies {
  return {
    still: policy("still", STILL_LADDER.map((spec) => spec.maxLongEdge)),
    video: policy(
      "video",
      VIDEO_LADDER
        .filter((spec) => spec.kind === "poster" || spec.kind === "transcode")
        .map((spec) => spec.maxLongEdge),
    ),
  };
}

export function canonicalTarget(policy: RenditionThresholdPolicy, requiredLongEdge: number): number {
  return (
    policy.targetLongEdges.find((target) => target >= requiredLongEdge) ??
    policy.targetLongEdges[policy.targetLongEdges.length - 1]!
  );
}
