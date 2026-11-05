import React, { createContext, useContext, useReducer } from "react";
import type { AppImage } from "@/photos-lib/client";
import type { RenditionPolicies } from "@/photos-lib/rendition-policy";

type PhotoAction =
  | { type: "SET_IMAGES"; images: AppImage[] }
  | { type: "APPEND_IMAGES"; images: AppImage[] }
  | { type: "UPSERT_IMAGES"; images: AppImage[] }
  | { type: "OPTIMISTIC_UPDATE"; image: AppImage }
  | { type: "OPTIMISTIC_DELETE"; id: string }
  | { type: "REMOVE_IMAGES"; ids: string[] }
  | { type: "SET_NEXT_CURSOR"; cursor: string | null }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "SET_POLICIES"; policies: RenditionPolicies }
  | { type: "SET_ALBUM_MEMBERSHIP"; ids: readonly string[]; albumId: string; member: boolean }
  | { type: "FORGET_ALBUM"; albumId: string };

interface PhotoState {
  images: AppImage[];
  nextCursor: string | null;
  loading: boolean;
  /**
   * Whether a load of the library has succeeded at least once. Apart from
   * `loading`, which a failed first load also turns off: only a load that
   * succeeded and found nothing means the library is empty.
   */
  loaded: boolean;
  policies: RenditionPolicies | null;
}

export function photoReducer(state: PhotoState, action: PhotoAction): PhotoState {
  switch (action.type) {
    case "SET_IMAGES":
      return { ...state, images: action.images, loaded: true };
    case "APPEND_IMAGES":
      return { ...state, images: [...state.images, ...action.images] };
    case "UPSERT_IMAGES": {
      const incoming = new Map(action.images.map(img => [img.id, img]));
      const merged = state.images.map(img => incoming.get(img.id) ?? img);
      const existingIds = new Set(state.images.map(img => img.id));
      const added = action.images.filter(img => !existingIds.has(img.id));
      return { ...state, images: [...merged, ...added] };
    }
    case "OPTIMISTIC_UPDATE":
      return {
        ...state,
        images: state.images.map((img) =>
          img.id === action.image.id ? action.image : img,
        ),
      };
    case "OPTIMISTIC_DELETE":
      return { ...state, images: state.images.filter((img) => img.id !== action.id) };
    case "REMOVE_IMAGES": {
      // Records deleted elsewhere. The open photo lives in the URL, and
      // `app.tsx` closes the viewer when the photo it names leaves the list.
      const gone = new Set(action.ids);
      if (!state.images.some((img) => gone.has(img.id))) return state;
      return { ...state, images: state.images.filter((img) => !gone.has(img.id)) };
    }
    case "SET_NEXT_CURSOR":
      return { ...state, nextCursor: action.cursor };
    case "SET_LOADING":
      return { ...state, loading: action.loading };
    case "SET_POLICIES":
      return { ...state, policies: action.policies };
    case "SET_ALBUM_MEMBERSHIP": {
      // The label write has already succeeded. The library delta follows
      // record changes, not label changes, so the list is updated here rather
      // than waiting for a reload to read the new labels.
      const ids = new Set(action.ids);
      return {
        ...state,
        images: state.images.map((img) => {
          if (!ids.has(img.id)) return img;
          const current = img.albumIds ?? [];
          const has = current.includes(action.albumId);
          if (has === action.member) return img;
          const albumIds = action.member
            ? [...current, action.albumId]
            : current.filter((id) => id !== action.albumId);
          return { ...img, albumIds };
        }),
      };
    }
    case "FORGET_ALBUM":
      return {
        ...state,
        images: state.images.map((img) =>
          img.albumIds?.includes(action.albumId)
            ? { ...img, albumIds: img.albumIds.filter((id) => id !== action.albumId) }
            : img,
        ),
      };
    default:
      return state;
  }
}

interface PhotoContextValue {
  state: PhotoState;
  dispatch: React.Dispatch<PhotoAction>;
}

const PhotoContext = createContext<PhotoContextValue | null>(null);

export function PhotoProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(photoReducer, {
    images: [],
    nextCursor: null,
    // An app that has not asked the server anything yet is loading, not empty.
    // Starting false meant the grid's `images.length === 0 && !loading` branch
    // was true from first paint until the first list call returned, so a cold
    // cloud load showed "No photos yet. Upload some to get started." to people
    // whose library was already there. The first fetchAll clears it.
    loading: true,
    loaded: false,
    policies: null,
  });

  return (
    <PhotoContext.Provider value={{ state, dispatch }}>
      {children}
    </PhotoContext.Provider>
  );
}

export function usePhotoContext(): PhotoContextValue {
  const ctx = useContext(PhotoContext);
  if (!ctx) throw new Error("usePhotoContext must be used within a PhotoProvider");
  return ctx;
}
