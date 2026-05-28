import { useCallback, useEffect, useState } from "react";
import { withBasePath } from "@/lib/base-path";

/**
 * Wraps the photos-owned style-graphic endpoint at /api/photos/style-graphic.
 * That endpoint mediates the platform's generic /app-data/files API — the UI
 * stays unaware of the underlying object-storage key. Upload is a raw-bytes
 * PUT with Content-Type carrying the mime; same-origin so no CORS, no base64
 * inflation.
 */
export function useStyleGraphic() {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const resp = await fetch(withBasePath("/api/photos/style-graphic"));
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
      await fetch(withBasePath("/api/photos/style-graphic"), {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(async (): Promise<void> => {
    await fetch(withBasePath("/api/photos/style-graphic"), { method: "DELETE" });
    await refresh();
  }, [refresh]);

  return { url, loading, upload, remove, refresh };
}
