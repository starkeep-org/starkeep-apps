/**
 * The photographs the engine integration test runs against.
 *
 * Separate from the script that downloads them so the test can ask *whether*
 * they are installed without running the download — the script has a top-level
 * `await main()`, and importing it would fetch 5 MB as a side effect of asking
 * a question.
 *
 * Not committed. They are photographs of people's faces, which a source
 * repository has no business carrying in order to run its tests, and the test
 * they feed already needs 278 MB of uncommitted models besides.
 *
 * These four are **US federal government works in the public domain**, chosen
 * for what the test needs rather than for their subjects: two different
 * portraits of one person (an identity *floor*, which a single photo cannot
 * establish), other people (a *ceiling*), and a four-person group photo (a box
 * count, which a portrait cannot establish).
 *
 * Pinned by SHA-256 like the models, so a mirror serving different bytes fails
 * loudly instead of quietly changing what the test asserts. And installed
 * alongside them under `app-assets/` — re-fetchable downloads, not state.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { visionAssetsDir } from "../../src/vision/paths";

export interface VisionFixture {
  fileName: string;
  url: string;
  sha256: string;
  /** What this file is for, in the test's terms. */
  role: string;
}

const COMMONS = "https://upload.wikimedia.org/wikipedia/commons";

export const VISION_FIXTURES: VisionFixture[] = [
  {
    fileName: "portrait-a1.jpg",
    url: `${COMMONS}/8/8d/President_Barack_Obama.jpg`,
    sha256: "744dd848fbb0584229169e01c4944664957c62495fb9e8af514a088ebca43e19",
    role: "one face; person A",
  },
  {
    fileName: "portrait-a2.jpg",
    url: `${COMMONS}/e/e9/Official_portrait_of_Barack_Obama.jpg`,
    sha256: "19ec613e6831dd0c285b907f4cf1be13a654f8ac237435146320ec3dcc42cd45",
    role: "one face; person A again, four years apart",
  },
  {
    fileName: "group-4.jpg",
    url: `${COMMONS}/2/26/Obama_family_portrait_in_the_Green_Room.jpg`,
    sha256: "adfeea7a3c014092e83199e365a02e97b545afee4229c4bdb7c92452c07b5062",
    role: "four faces",
  },
  {
    fileName: "group-4b.jpg",
    url: `${COMMONS}/5/5d/Barack_Obama_family_portrait_2011.jpg`,
    sha256: "eb5a6a6a217c8b7bb398088789843e41ea3df28d91bbeffe8653ec645b83038c",
    role: "the same four people, two years later",
  },
];

export function fixturesDir(): string {
  return join(visionAssetsDir(), "test-fixtures");
}

export function fixturePath(fileName: string): string {
  return join(fixturesDir(), fileName);
}

export function fixturesInstalled(): boolean {
  return VISION_FIXTURES.every((f) => {
    try {
      return statSync(fixturePath(f.fileName)).size > 0;
    } catch {
      return false;
    }
  });
}
