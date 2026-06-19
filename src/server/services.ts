import { Effect } from "effect";
import { nanoid } from "nanoid";
import type { Event, Guest, Photo } from "../db/schema";
import type { CreateEventRequest, LoginRequest } from "../shared/api";
import { MAX_FILE_SIZE, MAX_PHOTOS_PER_GUEST, AppError } from "./types";
import type { Repositories } from "./repositories";
import { isImage } from "./security";

export type PreparedUpload = {
  id: string;
  objectKey: string;
  filename: string;
  contentType: string;
  size: number;
  buffer: ArrayBuffer;
};

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const normalizePhone = (phone: string) => phone.replace(/[^0-9+]/g, "").trim();
const normalizeCode = (code: string) =>
  code
    .replace(/[^a-zA-Z0-9-]/g, "")
    .toUpperCase()
    .trim();

const randomRoomCode = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join("");
};

export const eventDto = (event: Event) => ({
  id: event.id,
  name: event.name,
  code: event.code,
  createdAt: event.createdAt.toISOString(),
});

export const guestDto = (guest: Guest) => ({ id: guest.id, name: guest.name, phone: guest.phone });

export const photoDto = (photo: {
  id: string;
  guestName: string;
  filename: string;
  size: number;
  createdAt: Date;
  isMine: boolean;
}) => ({
  id: photo.id,
  guestName: photo.guestName,
  filename: photo.filename,
  size: photo.size,
  createdAt: photo.createdAt.toISOString(),
  isMine: photo.isMine,
  url: `/photo/${photo.id}`,
});

export const makeServices = (repo: Repositories) => ({
  getGuestFromSession: (session: { guestId: string; eventId: string } | null) =>
    Effect.gen(function* () {
      if (!session) return null;
      const guest = yield* repo.guests.findById(session.guestId);
      if (guest && guest.eventId !== session.eventId) return null;
      return guest;
    }),
  login: (input: LoginRequest) =>
    Effect.gen(function* () {
      const phone = normalizePhone(input.phone);
      const name = input.name.trim();
      const code = normalizeCode(input.code);

      if (name.length < 2) return yield* Effect.fail(new AppError("Please enter your name."));
      if (phone.length < 7)
        return yield* Effect.fail(new AppError("Please enter a valid phone number."));
      if (code.length < 3) return yield* Effect.fail(new AppError("Please enter a room code."));

      const event = yield* repo.events.findByCode(code);
      if (!event)
        return yield* Effect.fail(
          new AppError("That room code does not match any wedding room.", 401),
        );

      const existing = yield* repo.guests.findByEventAndPhone(event.id, phone);
      if (existing) return existing;

      return yield* repo.guests.create({
        id: nanoid(),
        eventId: event.id,
        name,
        phone,
        createdAt: new Date(),
      });
    }),
  createEvent: (input: CreateEventRequest) =>
    Effect.gen(function* () {
      const name = input.name.trim();
      const code = normalizeCode(input.code ?? "") || randomRoomCode();

      if (name.length < 2) return yield* Effect.fail(new AppError("Please enter an event name."));
      if (code.length < 3)
        return yield* Effect.fail(
          new AppError("Please enter a room code with at least 3 characters."),
        );

      return yield* repo.events.create({ id: nanoid(), name, code, createdAt: new Date() });
    }),
  listGallery: (guest: Guest, scope: string) =>
    Effect.gen(function* () {
      const gallery = yield* repo.photos.listForGuestEvent(guest);
      const scoped = scope === "personal" ? gallery.filter((photo) => photo.isMine) : gallery;
      return scoped.map(photoDto);
    }),
  countRemaining: (guestId: string) =>
    Effect.gen(function* () {
      const uploaded = yield* repo.photos.countByGuest(guestId);
      return Math.max(0, MAX_PHOTOS_PER_GUEST - uploaded);
    }),
  preparePhotos: (guest: Guest, files: File[]) =>
    Effect.gen(function* () {
      if (files.length === 0) return yield* Effect.fail(new AppError("Choose at least one photo."));
      const uploaded = yield* repo.photos.countByGuest(guest.id);
      if (uploaded + files.length > MAX_PHOTOS_PER_GUEST) {
        return yield* Effect.fail(
          new AppError(`You can upload ${MAX_PHOTOS_PER_GUEST - uploaded} more photo(s).`),
        );
      }

      const prepared: PreparedUpload[] = [];
      for (const file of files) {
        const contentType = file.type.toLowerCase().split(";")[0] ?? "";
        if (!contentType.startsWith("image/"))
          return yield* Effect.fail(new AppError("Please upload image files only."));
        if (file.size > MAX_FILE_SIZE)
          return yield* Effect.fail(new AppError("Each photo must be 10MB or smaller."));

        const buffer = yield* Effect.tryPromise({
          try: () => file.arrayBuffer(),
          catch: () => new AppError("Could not read photo.", 500),
        });
        if (!isImage(contentType, new Uint8Array(buffer.slice(0, 12)))) {
          return yield* Effect.fail(
            new AppError("That file does not look like a supported image."),
          );
        }

        const id = nanoid();
        const safeName = (file.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "photo").slice(0, 120);
        const objectKey = `${guest.id}/${id}-${safeName}`;
        prepared.push({ id, objectKey, filename: file.name, contentType, size: file.size, buffer });
      }

      return { remaining: Math.max(0, MAX_PHOTOS_PER_GUEST - uploaded - files.length), prepared };
    }),
  completePreparedPhotos: (guest: Guest, prepared: PreparedUpload[]) =>
    Effect.gen(function* () {
      for (const item of prepared) {
        yield* repo.blobs.put(
          item.objectKey,
          item.buffer,
          item.contentType,
          guest.id,
          item.filename,
        );
        const photo: Photo = {
          id: item.id,
          guestId: guest.id,
          objectKey: item.objectKey,
          filename: item.filename,
          contentType: item.contentType,
          size: item.size,
          createdAt: new Date(),
        };
        yield* repo.photos.create(photo);
      }
    }),
  deletePhoto: (guest: Guest, photoId: string) =>
    Effect.gen(function* () {
      const photo = yield* repo.photos.findById(photoId);
      if (!photo) return yield* Effect.fail(new AppError("Photo not found.", 404));
      if (photo.guestId !== guest.id)
        return yield* Effect.fail(new AppError("You can only remove your own photos.", 403));
      yield* repo.blobs.delete(photo.objectKey);
      yield* repo.photos.delete(photo.id);
    }),
  getPhoto: (guest: Guest, photoId: string) =>
    Effect.gen(function* () {
      const photo = yield* repo.photos.findForEvent(photoId, guest.eventId);
      if (!photo) return yield* Effect.fail(new AppError("Photo not found.", 404));
      const object = yield* repo.blobs.get(photo.objectKey);
      if (!object) return yield* Effect.fail(new AppError("Photo not found.", 404));
      return { photo, object };
    }),
});

export type Services = ReturnType<typeof makeServices>;
