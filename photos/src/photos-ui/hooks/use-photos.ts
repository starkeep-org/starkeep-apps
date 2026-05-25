import { useCallback, useEffect } from "react";
import type { AppImage } from "@/photos-lib";
import { usePhotoContext } from "../context/photo-context";
import { withBasePath } from "@/lib/base-path";

export function usePhotos() {
  const { state, dispatch } = usePhotoContext();

  const fetchPhotos = useCallback(async (cursor?: string) => {
    dispatch({ type: "SET_LOADING", loading: true });
    try {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(withBasePath(`/api/photos?${params}`));
      if (!res.ok) return;
      const data = (await res.json()) as { images: AppImage[]; nextCursor: string | null };
      if (cursor) {
        dispatch({ type: "APPEND_IMAGES", images: data.images });
      } else {
        dispatch({ type: "SET_IMAGES", images: data.images });
      }
      dispatch({ type: "SET_NEXT_CURSOR", cursor: data.nextCursor });
    } finally {
      dispatch({ type: "SET_LOADING", loading: false });
    }
  }, [dispatch]);

  useEffect(() => {
    void fetchPhotos();
  }, [fetchPhotos]);

  const loadMore = useCallback(() => {
    if (state.nextCursor) void fetchPhotos(state.nextCursor);
  }, [fetchPhotos, state.nextCursor]);

  /** Fetch a single image by ID (used to load originals from thumbnail.parentId) */
  const fetchImage = useCallback(async (id: string): Promise<AppImage | null> => {
    const res = await fetch(withBasePath(`/api/photos/${id}`));
    if (!res.ok) return null;
    const data = (await res.json()) as { image: AppImage };
    return data.image;
  }, []);

  const uploadPhoto = useCallback(async (file: File, title?: string, caption?: string): Promise<AppImage | null> => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("originalFilename", file.name);
    if (title) formData.append("title", title);
    if (caption) formData.append("caption", caption ?? "");

    const res = await fetch(withBasePath("/api/photos"), { method: "POST", body: formData });
    if (!res.ok) return null;
    const data = (await res.json()) as { image: AppImage };
    // After upload a thumbnail record will be present; refresh the list
    void fetchPhotos();
    return data.image;
  }, [dispatch, fetchPhotos]);

  const updatePhoto = useCallback(async (
    id: string,
    updates: { caption?: string; title?: string; dateTakenOverride?: string | null },
  ): Promise<AppImage | null> => {
    const res = await fetch(withBasePath(`/api/photos/${id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { image: AppImage };
    return data.image;
  }, []);

  const deletePhoto = useCallback(async (id: string): Promise<boolean> => {
    const res = await fetch(withBasePath(`/api/photos/${id}`), { method: "DELETE" });
    if (!res.ok) return false;
    dispatch({ type: "OPTIMISTIC_DELETE", id });
    return true;
  }, [dispatch]);

  const cropPhoto = useCallback(async (
    sourceImageId: string,
    cropRect: { x: number; y: number; width: number; height: number },
  ): Promise<AppImage | null> => {
    const res = await fetch(withBasePath("/api/photos/crop"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceImageId, cropRect }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { image: AppImage };
    // Refresh list to show the new thumbnail
    void fetchPhotos();
    return data.image;
  }, [fetchPhotos]);

  const sharePhoto = useCallback(async (imageId: string): Promise<{ token: string; shareUrl: string } | null> => {
    const res = await fetch(withBasePath("/api/share"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageId }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { token: string; shareUrl: string };
  }, []);

  return {
    images: state.images,
    selectedId: state.selectedId,
    nextCursor: state.nextCursor,
    loading: state.loading,
    fetchPhotos,
    loadMore,
    fetchImage,
    uploadPhoto,
    updatePhoto,
    deletePhoto,
    cropPhoto,
    sharePhoto,
    selectImage: (id: string | null) => dispatch({ type: "SET_SELECTED_ID", id }),
  };
}
