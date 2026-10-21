import { describe, expect, it } from "vitest";
import { requireOriginalUri, shouldAskForMediaLocation } from "../src/media/original-uri";

describe("requireOriginalUri", () => {
  it("marks a MediaStore URI so reads return the unredacted bytes", () => {
    expect(requireOriginalUri("content://media/external/video/media/5185")).toBe(
      "content://media/external/video/media/5185?requireOriginal=1",
    );
  });

  it("appends to an existing query and never twice", () => {
    expect(requireOriginalUri("content://media/external/images/media/1?x=y")).toBe(
      "content://media/external/images/media/1?x=y&requireOriginal=1",
    );
    const marked = requireOriginalUri("content://media/external/images/media/1");
    expect(requireOriginalUri(marked)).toBe(marked);
  });

  it("leaves a non-MediaStore URI alone", () => {
    expect(requireOriginalUri("file:///data/user/0/app/files/a.jpg")).toBe(
      "file:///data/user/0/app/files/a.jpg",
    );
  });
});

describe("shouldAskForMediaLocation", () => {
  it("asks once, and only with media access granted", () => {
    expect(shouldAskForMediaLocation({ mediaGranted: true, locationGranted: false, askedThisLaunch: false })).toBe(true);
    expect(shouldAskForMediaLocation({ mediaGranted: true, locationGranted: false, askedThisLaunch: true })).toBe(false);
    expect(shouldAskForMediaLocation({ mediaGranted: false, locationGranted: false, askedThisLaunch: false })).toBe(false);
    expect(shouldAskForMediaLocation({ mediaGranted: true, locationGranted: true, askedThisLaunch: false })).toBe(false);
  });
});
