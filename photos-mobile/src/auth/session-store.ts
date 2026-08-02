/**
 * Keeping a session across app restarts.
 *
 * Only the refresh token and the email are stored. Access and id tokens live an
 * hour and are re-obtained on launch, so writing them down would buy nothing and
 * leave two more copies of a bearer credential on disk.
 *
 * **Where it is stored, and what that is worth.** The app's private document
 * directory: readable by this app, and on a non-rooted device by nothing else.
 * That is weaker than the Android keystore, which `expo-secure-store` would
 * give — and it is the deliberate choice for now, because the keystore is a
 * native module and this is the shell that exists to prove the app runs at all.
 * The upgrade is one dependency and one file, and it is worth doing before this
 * app holds anything but a dev pool's session.
 *
 * Written against the `ExpoFileSystem` port rather than `expo-file-system`, so
 * restart survival — the thing that is otherwise only checkable by killing an
 * app on a handset — is a unit test.
 */

import type { ExpoFileSystem } from "../storage/expo-object-storage";

export interface StoredSession {
  readonly refreshToken: string;
  readonly email: string | null;
}

export interface SessionStore {
  read(): Promise<StoredSession | null>;
  write(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

export function createSessionStore(fs: ExpoFileSystem, path: string): SessionStore {
  return {
    async read() {
      const file = fs.file(path);
      if (!file.exists) return null;
      try {
        const parsed = JSON.parse(await file.text()) as Partial<StoredSession>;
        // A truncated or half-written file is indistinguishable from no session
        // and must be treated as one: the alternative is an app that cannot get
        // past its own launch, on a device, with no way to clear the file.
        if (!parsed.refreshToken) return null;
        return { refreshToken: parsed.refreshToken, email: parsed.email ?? null };
      } catch {
        return null;
      }
    },

    async write(session) {
      const file = fs.file(path);
      if (!file.exists) file.create({ intermediates: true, overwrite: false });
      file.write(JSON.stringify(session));
    },

    async clear() {
      const file = fs.file(path);
      if (file.exists) file.delete();
    },
  };
}
