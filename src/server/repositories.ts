import { and, count, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect } from "effect";
import { events, guests, photos, type Event, type Guest, type Photo } from "../db/schema";
import { AppError, type Env } from "./types";

export type GalleryPhoto = Photo & { guestName: string; isMine: boolean };

export const makeRepositories = (env: Env["Bindings"]) => {
  const db = drizzle(env.DB);

  return {
    guests: {
      findById: (id: string) =>
        Effect.tryPromise({
          try: async () => {
            const [guest] = await db.select().from(guests).where(eq(guests.id, id)).limit(1);
            return guest ?? null;
          },
          catch: () => new AppError("Could not load guest.", 500),
        }),
      findByEventAndPhone: (eventId: string, phone: string) =>
        Effect.tryPromise({
          try: async () => {
            const [guest] = await db
              .select()
              .from(guests)
              .where(and(eq(guests.eventId, eventId), eq(guests.phone, phone)))
              .limit(1);
            return guest ?? null;
          },
          catch: () => new AppError("Could not load guest.", 500),
        }),
      create: (guest: Guest) =>
        Effect.tryPromise({
          try: async () => {
            await db.insert(guests).values(guest);
            return guest;
          },
          catch: () => new AppError("Could not create guest account.", 500),
        }),
    },
    events: {
      findByCode: (code: string) =>
        Effect.tryPromise({
          try: async () => {
            const [event] = await db.select().from(events).where(eq(events.code, code)).limit(1);
            return event ?? null;
          },
          catch: () => new AppError("Could not load room.", 500),
        }),
      create: (event: Event) =>
        Effect.tryPromise({
          try: async () => {
            await db.insert(events).values(event);
            return event;
          },
          catch: (error) => {
            if (error instanceof Error && error.message.includes("UNIQUE")) {
              return new AppError("That room code is already used.");
            }
            return new AppError("Could not create room.", 500);
          },
        }),
    },
    photos: {
      countByGuest: (guestId: string) =>
        Effect.tryPromise({
          try: async () => {
            const [{ total }] = await db
              .select({ total: count() })
              .from(photos)
              .where(eq(photos.guestId, guestId));
            return total;
          },
          catch: () => new AppError("Could not check your upload limit.", 500),
        }),
      listForGuestEvent: (guest: Guest) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select({
                id: photos.id,
                guestId: photos.guestId,
                objectKey: photos.objectKey,
                filename: photos.filename,
                contentType: photos.contentType,
                size: photos.size,
                createdAt: photos.createdAt,
                guestName: guests.name,
              })
              .from(photos)
              .innerJoin(guests, eq(photos.guestId, guests.id))
              .where(eq(guests.eventId, guest.eventId))
              .orderBy(desc(photos.createdAt));

            return rows.map((photo) => ({ ...photo, isMine: photo.guestId === guest.id }));
          },
          catch: () => new AppError("Could not load gallery.", 500),
        }),
      findForEvent: (photoId: string, eventId: string) =>
        Effect.tryPromise({
          try: async () => {
            const [photo] = await db
              .select({
                id: photos.id,
                guestId: photos.guestId,
                objectKey: photos.objectKey,
                filename: photos.filename,
                contentType: photos.contentType,
                size: photos.size,
                createdAt: photos.createdAt,
              })
              .from(photos)
              .innerJoin(guests, eq(photos.guestId, guests.id))
              .where(and(eq(photos.id, photoId), eq(guests.eventId, eventId)))
              .limit(1);
            return photo ?? null;
          },
          catch: () => new AppError("Could not load photo.", 500),
        }),
      findById: (photoId: string) =>
        Effect.tryPromise({
          try: async () => {
            const [photo] = await db.select().from(photos).where(eq(photos.id, photoId)).limit(1);
            return photo ?? null;
          },
          catch: () => new AppError("Could not load photo.", 500),
        }),
      create: (photo: Photo) =>
        Effect.tryPromise({
          try: async () => {
            await db.insert(photos).values(photo);
          },
          catch: () => new AppError("Could not save photo.", 500),
        }),
      delete: (photoId: string) =>
        Effect.tryPromise({
          try: async () => {
            await db.delete(photos).where(eq(photos.id, photoId));
          },
          catch: () => new AppError("Could not remove photo.", 500),
        }),
    },
    blobs: {
      put: (
        key: string,
        buffer: ArrayBuffer,
        contentType: string,
        guestId: string,
        originalName: string,
      ) =>
        Effect.tryPromise({
          try: () =>
            env.PHOTOS.put(key, buffer, {
              httpMetadata: { contentType },
              customMetadata: { guestId, originalName },
            }),
          catch: () => new AppError("Could not store photo.", 500),
        }),
      get: (key: string) =>
        Effect.tryPromise({
          try: () => env.PHOTOS.get(key),
          catch: () => new AppError("Could not load photo.", 500),
        }),
      delete: (key: string) =>
        Effect.tryPromise({
          try: () => env.PHOTOS.delete(key),
          catch: () => new AppError("Could not remove photo.", 500),
        }),
    },
  };
};

export type Repositories = ReturnType<typeof makeRepositories>;
