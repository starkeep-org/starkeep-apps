/**
 * The albums and their public links, as the app shell holds them.
 *
 * Albums load once and update in place after each change this page makes.
 * Membership is not here: each photo carries its albums from its labels, and
 * the photo list is the one source for which photos an album holds.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Album } from "@/photos-lib/client";
import {
  changeAlbumMembers,
  createAlbum,
  createPublicLink,
  deleteAlbum,
  deletePublicLink,
  listAlbums,
  listPublicLinks,
  updateAlbum,
  updatePublicLink,
  type LinkLifetime,
  type PublicLink,
  type PublicLinksState,
} from "./albums-client";

export interface AlbumsState {
  albums: readonly Album[];
  loading: boolean;
  error: string | null;
  links: PublicLinksState | null;
  /** Ask the cloud for the links again, after a sign-in or a reconnect. */
  reloadLinks(): Promise<void>;
  /** The album's link, if it has one. One link per album. */
  linkOf(albumId: string): PublicLink | null;
  /** The photo's own link, if it has one. One link per photo. */
  photoLinkOf(photoId: string): PublicLink | null;
  /** Albums with a link that still opens. */
  linkedAlbumIds: ReadonlySet<string>;
  create(title: string): Promise<Album>;
  rename(album: Album, title: string): Promise<void>;
  setCover(album: Album, recordId: string): Promise<void>;
  remove(album: Album): Promise<void>;
  addMembers(album: Album, ids: readonly string[]): Promise<void>;
  removeMembers(album: Album, ids: readonly string[]): Promise<void>;
  createLink(album: Album, input: { title: string; lifetime: LinkLifetime }): Promise<void>;
  createPhotoLink(photoId: string, input: { title: string; lifetime: LinkLifetime }): Promise<void>;
  changeLinkLifetime(link: PublicLink, lifetime: LinkLifetime): Promise<void>;
  replaceLink(link: PublicLink): Promise<void>;
  stopLink(link: PublicLink): Promise<void>;
}

export function useAlbums(onMembership: (ids: readonly string[], albumId: string, member: boolean) => void, onForget: (albumId: string) => void): AlbumsState {
  const [albums, setAlbums] = useState<readonly Album[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<PublicLinksState | null>(null);

  const loadLinks = useCallback(async () => {
    try {
      setLinks(await listPublicLinks());
    } catch (err) {
      setLinks({ available: false, reason: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    listAlbums()
      .then((list) => {
        if (!cancelled) setAlbums(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // A link list that fails leaves badges off; the dialog says why on open.
    void loadLinks();
    return () => {
      cancelled = true;
    };
  }, [loadLinks]);

  const setLinkList = useCallback((update: (list: readonly PublicLink[]) => readonly PublicLink[]) => {
    setLinks((state) => (state?.available ? { ...state, links: update(state.links) } : state));
  }, []);

  const linkOf = useCallback(
    (albumId: string) => (links?.available ? (links.links.find((l) => l.albumId === albumId) ?? null) : null),
    [links],
  );

  const photoLinkOf = useCallback(
    (photoId: string) => (links?.available ? (links.links.find((l) => l.photoId === photoId) ?? null) : null),
    [links],
  );

  const linkedAlbumIds = useMemo(() => {
    const now = Date.now();
    return new Set(
      links?.available
        ? links.links
            .filter((l) => l.expiresAtMs === null || l.expiresAtMs > now)
            .flatMap((l) => (l.albumId === null ? [] : [l.albumId]))
        : [],
    );
  }, [links]);

  return {
    albums,
    loading,
    error,
    links,
    reloadLinks: loadLinks,
    linkOf,
    photoLinkOf,
    linkedAlbumIds,
    async create(title) {
      const album = await createAlbum(title);
      setAlbums((list) => [album, ...list]);
      return album;
    },
    async rename(album, title) {
      await updateAlbum(album.id, { title });
      setAlbums((list) => list.map((a) => (a.id === album.id ? { ...a, title } : a)));
    },
    async setCover(album, recordId) {
      await updateAlbum(album.id, { coverRecordId: recordId });
      setAlbums((list) => list.map((a) => (a.id === album.id ? { ...a, coverRecordId: recordId } : a)));
    },
    async remove(album) {
      const link = linkOf(album.id);
      // A link to a deleted album would show nothing; stop it first.
      if (link) {
        await deletePublicLink(link.id);
        setLinkList((list) => list.filter((l) => l.id !== link.id));
      }
      await deleteAlbum(album.id);
      setAlbums((list) => list.filter((a) => a.id !== album.id));
      onForget(album.id);
    },
    async addMembers(album, ids) {
      await changeAlbumMembers(album.id, { add: ids });
      onMembership(ids, album.id, true);
    },
    async removeMembers(album, ids) {
      await changeAlbumMembers(album.id, { remove: ids });
      onMembership(ids, album.id, false);
    },
    async createLink(album, input) {
      const link = await createPublicLink({ albumId: album.id, ...input });
      setLinkList((list) => [...list, link]);
    },
    async createPhotoLink(photoId, input) {
      const link = await createPublicLink({ photoId, ...input });
      setLinkList((list) => [...list, link]);
    },
    async changeLinkLifetime(link, lifetime) {
      const next = await updatePublicLink(link.id, { lifetime });
      setLinkList((list) => list.map((l) => (l.id === link.id ? next : l)));
    },
    async replaceLink(link) {
      const next = await updatePublicLink(link.id, { rotateLink: true });
      setLinkList((list) => list.map((l) => (l.id === link.id ? next : l)));
    },
    async stopLink(link) {
      await deletePublicLink(link.id);
      setLinkList((list) => list.filter((l) => l.id !== link.id));
    },
  };
}
