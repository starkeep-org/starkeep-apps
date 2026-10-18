/** An in-memory `expo-secure-store`, over the port `auth/session.ts` declares. */
import type { SecureStore } from "../../src/auth/session";

export function fakeSecureStore(): { store: SecureStore; items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    store: {
      async getItemAsync(key) {
        return items.get(key) ?? null;
      },
      async setItemAsync(key, value) {
        items.set(key, value);
      },
      async deleteItemAsync(key) {
        items.delete(key);
      },
    },
  };
}
