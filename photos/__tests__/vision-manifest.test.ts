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

  it("stays within the platform's 64-key-per-app cap with room to spare", () => {
    // The cap exists to force keys to be schema. Objects and scene are still to
    // come; this is a smoke alarm, not a limit.
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
