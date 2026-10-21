import { describe, expect, it } from "vitest";
import { createFileMultipartSessions, type SessionFile } from "../src/storage/multipart-sessions";

function memoryFile(initial: string | null = null): SessionFile & { contents: string | null } {
  const file = {
    contents: initial,
    read: () => file.contents,
    write: (c: string) => void (file.contents = c),
  };
  return file;
}

const session = { uploadId: "UP-1", partSha256Hex: ["a".repeat(64)], etags: { "1": '"e1"' } };

describe("createFileMultipartSessions", () => {
  it("remembers a session across store instances, as across app restarts", async () => {
    const file = memoryFile();
    await createFileMultipartSessions(file).set("k", session);
    expect(await createFileMultipartSessions(file).get("k")).toEqual(session);
  });

  it("keeps other keys' sessions when one is set or deleted", async () => {
    const store = createFileMultipartSessions(memoryFile());
    await store.set("a", session);
    await store.set("b", { ...session, uploadId: "UP-2" });
    await store.delete("a");
    expect(await store.get("a")).toBeNull();
    expect((await store.get("b"))?.uploadId).toBe("UP-2");
  });

  // A torn write or a hand-edited file must cost a fresh upload, never a crash
  // or a resumption against parts that do not exist.
  it("reads a damaged file, or a malformed entry, as no session", async () => {
    expect(await createFileMultipartSessions(memoryFile("{not json")).get("k")).toBeNull();
    const malformed = memoryFile(JSON.stringify({ k: { uploadId: 3 }, ok: session }));
    const store = createFileMultipartSessions(malformed);
    expect(await store.get("k")).toBeNull();
    expect(await store.get("ok")).toEqual(session);
  });

  it("reads a missing file as empty", async () => {
    expect(await createFileMultipartSessions(memoryFile(null)).get("k")).toBeNull();
  });
});
