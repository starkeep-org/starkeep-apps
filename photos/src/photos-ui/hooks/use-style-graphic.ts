import { useCallback, useEffect, useState } from "react";

/**
 * Wraps the photos-owned style-graphic endpoint at /api/photos/style-graphic.
 * That endpoint mediates the platform's generic /app-data/files API — the UI
 * stays unaware of the underlying object-storage key and the bytes are
 * transported as base64 JSON to keep the request body text-only.
 */
export function useStyleGraphic() {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const resp = await fetch("/api/photos/style-graphic");
      if (!resp.ok) {
        setUrl(null);
        return;
      }
      const body = (await resp.json()) as { url?: string | null };
      setUrl(body.url ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upload = useCallback(
    async (file: File): Promise<void> => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const fileBase64 = arrayBufferToBase64(bytes);
      await fetch("/api/photos/style-graphic", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileBase64, mimeType: file.type || "application/octet-stream" }),
      });
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(async (): Promise<void> => {
    await fetch("/api/photos/style-graphic", { method: "DELETE" });
    await refresh();
  }, [refresh]);

  return { url, loading, upload, remove, refresh };
}

function arrayBufferToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
