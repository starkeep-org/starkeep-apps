export interface GoogleAlbum {
  id: string;
  title: string;
  mediaItemsCount: string;
  coverPhotoBaseUrl: string | null;
}

export interface GoogleMediaItem {
  id: string;
  filename: string;
  mimeType: string;
  baseUrl: string;
  mediaMetadata: {
    creationTime: string;
    width: string;
    height: string;
  };
}
