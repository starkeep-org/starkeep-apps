import type { StarkeepSdk } from "@starkeep/sdk";
import { PHOTOS_APP_ID, PHOTOS_APP_RECORD_TYPES } from "./manifest";

/**
 * Idempotent bootstrap for the photos app. Call with an owner-level SDK
 * (no `subject`) before initialising the app-scoped SDK.
 *
 * Grants the photos app type-level read/write/delete policies for every
 * record type it needs. Idempotent — re-running on startup is safe.
 */
export async function bootstrapPhotosApp(ownerSdk: StarkeepSdk): Promise<void> {
  const existing = await ownerSdk.accessControl.listPolicies({ subjectId: PHOTOS_APP_ID });
  const coveredTypes = new Set(
    existing.filter((p) => p.resourceType === "type").map((p) => p.resourceId),
  );

  for (const recordType of PHOTOS_APP_RECORD_TYPES) {
    if (coveredTypes.has(recordType)) continue;

    await ownerSdk.accessControl.createPolicy({
      subjectType: "app",
      subjectId: PHOTOS_APP_ID,
      resourceType: "type",
      resourceId: recordType,
      permissions: ["read", "write", "delete"],
    });
  }
}
