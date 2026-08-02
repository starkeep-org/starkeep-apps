/**
 * Sessions surviving a restart, without a handset.
 *
 * "Auth survives an app restart" is on the Maestro list in the Android plan,
 * and it should be — but the half that is a file being written and read back is
 * decidable here, against the same in-memory expo-file-system the storage
 * adapter uses. What is left for a device is whether the OS keeps the directory,
 * which no fake can answer.
 */
import { describe, it, expect } from "vitest";
import { createSessionStore } from "../src/auth/session-store";
import { fakeExpoFs } from "./helpers/fake-expo-fs";

const PATH = "/documents/starkeep/session.json";

describe("session store", () => {
  it("has no session before anything is written", async () => {
    const { fs } = fakeExpoFs();
    expect(await createSessionStore(fs, PATH).read()).toBeNull();
  });

  it("reads back what a previous run wrote", async () => {
    const { fs } = fakeExpoFs();
    await createSessionStore(fs, PATH).write({ refreshToken: "r1", email: "a@example.com" });

    // A second store over the same filesystem is what a relaunch looks like:
    // nothing in memory, everything from disk.
    expect(await createSessionStore(fs, PATH).read()).toEqual({
      refreshToken: "r1",
      email: "a@example.com",
    });
  });

  it("stores only the refresh token and the email", async () => {
    // Access and id tokens expire within the hour and are re-obtained at launch,
    // so writing them down would leave extra copies of a bearer credential on
    // disk for nothing.
    const { fs, files } = fakeExpoFs();
    await createSessionStore(fs, PATH).write({ refreshToken: "r1", email: "a@example.com" });

    const written = JSON.parse(new TextDecoder().decode(files.get(PATH)!)) as object;
    expect(Object.keys(written).sort()).toEqual(["email", "refreshToken"]);
  });

  it("signing out leaves nothing behind", async () => {
    const { fs } = fakeExpoFs();
    const store = createSessionStore(fs, PATH);
    await store.write({ refreshToken: "r1", email: null });

    await store.clear();

    expect(await store.read()).toBeNull();
    expect(fs.file(PATH).exists).toBe(false);
  });

  it("clearing a session that is not there is not an error", async () => {
    const { fs } = fakeExpoFs();
    await expect(createSessionStore(fs, PATH).clear()).resolves.toBeUndefined();
  });

  it("treats a corrupt file as no session rather than throwing", async () => {
    // A phone can be killed mid-write. An app that cannot get past its own
    // launch because of a half-written file has no way to be fixed from the
    // phone — signing in again does.
    const { fs } = fakeExpoFs();
    fs.file(PATH).write('{"refreshToken":"r1"');

    expect(await createSessionStore(fs, PATH).read()).toBeNull();
  });

  it("treats a session with no refresh token as no session", async () => {
    const { fs } = fakeExpoFs();
    fs.file(PATH).write(JSON.stringify({ email: "a@example.com" }));

    expect(await createSessionStore(fs, PATH).read()).toBeNull();
  });

  it("overwrites the previous session rather than appending to it", async () => {
    const { fs } = fakeExpoFs();
    const store = createSessionStore(fs, PATH);
    await store.write({ refreshToken: "r1", email: "a@example.com" });

    await store.write({ refreshToken: "r2", email: "b@example.com" });

    expect(await store.read()).toEqual({ refreshToken: "r2", email: "b@example.com" });
  });
});
