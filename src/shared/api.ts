import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

export const GuestDto = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  phone: Schema.String,
});

export const EventDto = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  code: Schema.String,
  createdAt: Schema.String,
});

export const PhotoDto = Schema.Struct({
  id: Schema.String,
  guestName: Schema.String,
  filename: Schema.String,
  size: Schema.Number,
  createdAt: Schema.String,
  isMine: Schema.Boolean,
  url: Schema.String,
});

export const SessionResponse = Schema.Struct({
  guest: Schema.NullOr(GuestDto),
  eventCode: Schema.String,
  maxPhotos: Schema.Number,
  remaining: Schema.optional(Schema.Number),
});

export const LoginRequest = Schema.Struct({
  code: Schema.String,
  name: Schema.String,
  phone: Schema.String,
});

export const LoginResponse = Schema.Struct({
  guest: GuestDto,
});

export const GalleryResponse = Schema.Struct({
  photos: Schema.Array(PhotoDto),
});

export const CreateEventRequest = Schema.Struct({
  name: Schema.String,
  code: Schema.optional(Schema.String),
});

export const CreateEventResponse = Schema.Struct({
  event: EventDto,
  joinUrl: Schema.String,
});

export const UploadResponse = Schema.Struct({
  remaining: Schema.Number,
});

export const OkResponse = Schema.Struct({
  ok: Schema.Boolean,
});

export const ErrorResponse = Schema.Struct({
  error: Schema.String,
});

export type GuestDto = Schema.Schema.Type<typeof GuestDto>;
export type PhotoDto = Schema.Schema.Type<typeof PhotoDto>;
export type SessionResponse = Schema.Schema.Type<typeof SessionResponse>;
export type LoginRequest = Schema.Schema.Type<typeof LoginRequest>;
export type LoginResponse = Schema.Schema.Type<typeof LoginResponse>;
export type GalleryResponse = Schema.Schema.Type<typeof GalleryResponse>;
export type CreateEventRequest = Schema.Schema.Type<typeof CreateEventRequest>;
export type CreateEventResponse = Schema.Schema.Type<typeof CreateEventResponse>;
export type UploadResponse = Schema.Schema.Type<typeof UploadResponse>;
export type OkResponse = Schema.Schema.Type<typeof OkResponse>;

export const WeddingPhotosApi = HttpApi.make("WeddingPhotosApi").add(
  HttpApiGroup.make("api")
    .prefix("/api")
    .add(HttpApiEndpoint.get("session", "/session").addSuccess(SessionResponse))
    .add(HttpApiEndpoint.post("login", "/login").setPayload(LoginRequest).addSuccess(LoginResponse))
    .add(HttpApiEndpoint.get("gallery", "/gallery").addSuccess(GalleryResponse))
    .add(
      HttpApiEndpoint.post("createEvent", "/admin/events")
        .setPayload(CreateEventRequest)
        .addSuccess(CreateEventResponse),
    )
    .add(HttpApiEndpoint.post("upload", "/upload").addSuccess(UploadResponse))
    .add(HttpApiEndpoint.make("DELETE")("deletePhoto", "/photos/:id").addSuccess(OkResponse)),
);
