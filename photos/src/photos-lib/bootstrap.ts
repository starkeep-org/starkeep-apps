import type { StarkeepSdk } from "@starkeep/sdk";
import { PHOTOS_APP_ID, PHOTOS_APP_RECORD_TYPES, IMAGE_RECORD_TYPE } from "./manifest";

const IMAGE_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
  description:
    "A raw raster image file. Bytes live in object storage; deterministic metadata (dimensions, EXIF, GPS) is stored in shared_record_image_metadata.",
};

/**
 * Idempotent bootstrap for the photos app. Call with an owner-level SDK
 * (no `subject`) before initialising the app-scoped SDK.
 *
 * 1. Registers global types via the type-registration control plane.
 * 2. Grants the photos app type-level read/write/delete policies for every
 *    record type it needs.
 *
 * Both steps are idempotent — re-running on startup is safe and expected.
 */
export async function bootstrapPhotosApp(ownerSdk: StarkeepSdk): Promise<void> {
  await ownerSdk.typeRegistrations.register({
    typeId: IMAGE_RECORD_TYPE,
    schema: IMAGE_SCHEMA,
    schemaVersion: "1.0.0",
    description: "A raw raster image file stored in object storage.",
    registeredByAppId: PHOTOS_APP_ID,
  });

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
