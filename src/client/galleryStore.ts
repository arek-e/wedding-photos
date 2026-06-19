import { createCollection, localOnlyCollectionOptions } from "@tanstack/react-db";
import type { PhotoDto } from "../shared/api";

export type GalleryPhoto = PhotoDto & {
  uploadState?: "pending" | "failed";
};

export const galleryCollection = createCollection(
  localOnlyCollectionOptions<GalleryPhoto, string>({
    id: "gallery-photos",
    getKey: (photo) => photo.id,
  }),
);

const waitFor = (transaction: { isPersisted: { promise: Promise<unknown> } }) =>
  transaction.isPersisted.promise.catch(() => undefined);

export const upsertGalleryPhoto = (photo: GalleryPhoto) => {
  const existing = galleryCollection.state.get(photo.id);
  if (existing) {
    void waitFor(
      galleryCollection.update(photo.id, (draft) => {
        Object.assign(draft, photo);
        if (!photo.uploadState) delete draft.uploadState;
      }),
    );
    return;
  }
  void waitFor(galleryCollection.insert(photo));
};

export const removeGalleryPhoto = (id: string) => {
  if (!galleryCollection.state.has(id)) return;
  void waitFor(galleryCollection.delete(id));
};

export const addPendingPhotos = (photos: ReadonlyArray<GalleryPhoto>) => {
  photos.forEach(upsertGalleryPhoto);
};

export const syncServerPhotos = (serverPhotos: ReadonlyArray<PhotoDto>) => {
  const serverKeys = new Set(serverPhotos.map((photo) => photo.id));
  for (const photo of serverPhotos) {
    upsertGalleryPhoto(photo);
  }

  for (const photo of galleryCollection.state.values()) {
    if (!photo.uploadState && !serverKeys.has(photo.id)) removeGalleryPhoto(photo.id);
  }
};
