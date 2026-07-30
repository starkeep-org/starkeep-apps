import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LABEL_VALUE_MAX_BYTES, LABEL_VALUES_PER_KEY_MAX, PHOTOS_LABEL_KEYS } from "@/photos-lib";

/**
 * The manifest ↔ label-key contract.
 *
 * `admin-installer`'s `dsql-ddl.ts` reconciles the label-key registry at install
 * time and rejects writes to any key the manifest does not declare. So a key
 * that exists in code but not in the manifest fails **only after a re-install**,
 * with a 400 from the data server and nothing local to point at — the same shape
 * of failure the `manifest-routes` test exists to prevent for routes.
 *
 * Asserted in both directions: a key in code needs a manifest entry, and a
 * manifest entry with no key in code is a stale declaration that will be deleted
 * out from under some other app's queries.
 */

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
  id: string;
  infraRequirements?: {
    labelKeys?: Array<{ key: string; description?: string }>;
    appSpecificSyncable?: {
      tables?: Array<{ name: string; columns?: Array<{ name: string; type: string }> }>;
    };
  };
}

const manifest = JSON.parse(
  readFileSync(resolve(PKG_DIR, "starkeep.manifest.json"), "utf-8"),
) as Manifest;

const declared = manifest.infraRequirements?.labelKeys ?? [];
const declaredKeys = declared.map((k) => k.key).sort();
const codeKeys = Object.values(PHOTOS_LABEL_KEYS).sort();

describe("label keys", () => {
  it("declares exactly the keys the code writes", () => {
    expect(declaredKeys).toEqual(codeKeys);
  });

  it("declares the two face keys", () => {
    // Named explicitly so removing both from code *and* manifest — which would
    // satisfy the equality above — still fails.
    expect(declaredKeys).toContain("faces");
    expect(declaredKeys).toContain("face-count");
    expect(PHOTOS_LABEL_KEYS.faces).toBe("faces");
    expect(PHOTOS_LABEL_KEYS.faceCount).toBe("face-count");
  });

  it("gives every key a description", () => {
    // The registry is how another app's developer discovers what Photos
    // publishes without reading Photos' source; an undescribed key is a key
    // nobody outside this repo can use.
    for (const key of declared) {
      expect(key.description, `${key.key} has no description`).toBeTruthy();
      expect(key.description!.length).toBeGreaterThan(20);
    }
  });

  it("says of `faces` that it is multi-valued and opt-in", () => {
    const faces = declared.find((k) => k.key === "faces")!;
    expect(faces.description).toMatch(/multi-valued/i);
    // The description is the only place another app learns that an absent
    // `faces` means "not published", not "nobody in this photo".
    expect(faces.description).toMatch(/opt|enabled/i);
  });

  it("says of `face-count` that absence means zero", () => {
    const count = declared.find((k) => k.key === "face-count")!;
    expect(count.description).toMatch(/absent|never zero/i);
  });

  it("declares `tags`, and says only confirmed ones are published", () => {
    // §7's rule has to be discoverable from the registry, not only from Photos'
    // source: another app reading `photos/tags` needs to know it is looking at human
    // judgements rather than uncalibrated similarity scores. That distinction is the
    // whole reason the key is safe to consume.
    expect(declaredKeys).toContain("tags");
    expect(PHOTOS_LABEL_KEYS.tags).toBe("tags");
    const tags = declared.find((k) => k.key === "tags")!;
    expect(tags.description).toMatch(/multi-valued/i);
    expect(tags.description).toMatch(/confirm/i);
    expect(tags.description).toMatch(/suggest/i);
  });

  it("stays within the platform's 64-key-per-app cap with room to spare", () => {
    // The cap exists to force keys to be schema. This is a smoke alarm, not a limit —
    // objects deliberately publishes nothing, since a detection is not something a
    // human agreed with and `?label=photos/objects&labelValue=dog` would be asserting
    // a machine's guess as fact.
    expect(declaredKeys.length).toBeLessThan(16);
  });
});

describe("mirrored platform constants", () => {
  it("matches the values protocol-primitives enforces", () => {
    // Copied rather than imported — Photos depends only on
    // @starkeep/app-client, and a data-plane package would be a large
    // dependency for two numbers. Pinned here so the copy is at least visible.
    expect(LABEL_VALUE_MAX_BYTES).toBe(128);
    expect(LABEL_VALUES_PER_KEY_MAX).toBe(32);
  });
});

describe("the syncable table", () => {
  const enriched = manifest.infraRequirements?.appSpecificSyncable?.tables?.find(
    (t) => t.name === "image_enriched",
  );

  it("declares the column user tag edits are stored in", () => {
    // §3.6's trap: access is granted at install time from the manifest, so a column
    // that is not declared here does not exist until Photos is re-installed — and the
    // symptom is a rejected write, not a missing column.
    expect(enriched).toBeDefined();
    const columns = (enriched!.columns ?? []).map((c) => c.name);
    expect(columns).toContain("tag_edits");
  });

  it("keeps the columns that were already there", () => {
    // Adding `tag_edits` must not disturb the others: the partial upsert the tag
    // route uses relies on caption, title, and date_taken_override surviving a write
    // that does not mention them.
    const columns = (enriched!.columns ?? []).map((c) => c.name);
    for (const existing of ["record_id", "caption", "title", "date_taken_override"]) {
      expect(columns).toContain(existing);
    }
  });
});
