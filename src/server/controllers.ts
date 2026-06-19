import { Schema } from "effect";
import { Effect } from "effect";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  CreateEventRequest,
  CreateEventResponse,
  GalleryResponse,
  LoginRequest,
  LoginResponse,
  OkResponse,
  SessionResponse,
  UploadResponse,
} from "../shared/api";
import { makeRepositories } from "./repositories";
import { enforceRateLimit, securityHeaders } from "./security";
import { makeServices, eventDto, guestDto } from "./services";
import { makeSession, readSession } from "./session";
import { AppError, MAX_PHOTOS_PER_GUEST, SESSION_COOKIE, type AppContext, type Env } from "./types";

const run = <A>(effect: Effect.Effect<A, AppError, never>) => Effect.runPromise(effect);

const jsonError = (message: string, status = 400) => Response.json({ error: message }, { status });

const parseJson = async <A, I>(c: AppContext, schema: Schema.Schema<A, I, never>) => {
  const body = await c.req.json().catch(() => ({}));
  return Schema.decodeUnknownPromise(schema)(body);
};

const json = <A, I>(c: AppContext, schema: Schema.Schema<A, I, never>, value: A) =>
  c.json(Schema.encodeUnknownSync(schema)(value));

const joinUrl = (requestUrl: string, code: string) => {
  const url = new URL(requestUrl);
  url.pathname = "/";
  url.search = new URLSearchParams({ code }).toString();
  return url.toString();
};

const getServices = (c: AppContext) => makeServices(makeRepositories(c.env));

const currentGuest = async (c: AppContext) => {
  const session = await readSession(getCookie(c, SESSION_COOKIE), c.env.SESSION_SECRET);
  const guest = await run(getServices(c).getGuestFromSession(session));
  if (!guest) throw new AppError("Please join the wedding room first.", 401);
  return guest;
};

export const createApp = () => {
  const app = new Hono<Env>();

  app.use("*", securityHeaders);

  app.use("/api/*", async (c, next) => {
    try {
      await run(enforceRateLimit(c, "api", 300, 60));
      await next();
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError("Too many requests.", 429);
      return jsonError(appError.message, appError.status);
    }
  });

  app.get("/api/session", async (c) => {
    const session = await readSession(getCookie(c, SESSION_COOKIE), c.env.SESSION_SECRET);
    const guest = await run(getServices(c).getGuestFromSession(session));
    if (!guest) {
      return json(c, SessionResponse, {
        guest: null,
        eventCode: c.req.query("code") ?? c.env.EVENT_CODE ?? "",
        maxPhotos: MAX_PHOTOS_PER_GUEST,
      });
    }

    const remaining = await run(getServices(c).countRemaining(guest.id));
    return json(c, SessionResponse, {
      guest: guestDto(guest),
      eventCode: c.req.query("code") ?? "",
      maxPhotos: MAX_PHOTOS_PER_GUEST,
      remaining,
    });
  });

  app.post("/api/login", async (c) => {
    try {
      await run(enforceRateLimit(c, "login", 30, 600));
      const input = await parseJson(c, LoginRequest);
      const guest = await run(getServices(c).login(input));
      setCookie(c, SESSION_COOKIE, await makeSession(guest, c.env.SESSION_SECRET), {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
      return json(c, LoginResponse, { guest: guestDto(guest) });
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError("Could not sign in.");
      return jsonError(appError.message, appError.status);
    }
  });

  app.get("/api/gallery", async (c) => {
    try {
      const guest = await currentGuest(c);
      const photos = await run(getServices(c).listGallery(guest, c.req.query("scope") ?? "all"));
      return json(c, GalleryResponse, { photos });
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError("Could not load gallery.");
      return jsonError(appError.message, appError.status);
    }
  });

  app.post("/api/admin/events", async (c) => {
    try {
      await run(enforceRateLimit(c, "admin-events", 10, 3600));
      const input = await parseJson(c, CreateEventRequest);
      const event = await run(getServices(c).createEvent(input));
      return json(c, CreateEventResponse, {
        event: eventDto(event),
        joinUrl: joinUrl(c.req.url, event.code),
      });
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError("Could not create room.");
      return jsonError(appError.message, appError.status);
    }
  });

  app.post("/api/upload", async (c) => {
    try {
      await run(enforceRateLimit(c, "upload", 40, 3600));
      const guest = await currentGuest(c);
      const form = await c.req.raw.formData();
      const files = form
        .getAll("photos")
        .filter((item): item is File => typeof item !== "string" && item.size > 0);
      const services = getServices(c);
      const { remaining, prepared } = await run(services.preparePhotos(guest, files));
      c.executionCtx.waitUntil(
        run(services.completePreparedPhotos(guest, prepared)).catch((error) => {
          console.error("Background photo upload failed", error);
        }),
      );
      c.status(202);
      return json(c, UploadResponse, { remaining });
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError("Could not upload photo.");
      return jsonError(appError.message, appError.status);
    }
  });

  app.delete("/api/photos/:id", async (c) => {
    try {
      const guest = await currentGuest(c);
      await run(getServices(c).deletePhoto(guest, c.req.param("id")));
      return json(c, OkResponse, { ok: true });
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError("Could not remove photo.");
      return jsonError(appError.message, appError.status);
    }
  });

  app.get("/photo/:id", async (c) => {
    try {
      await run(enforceRateLimit(c, "photo", 600, 60));
      const guest = await currentGuest(c);
      const { photo, object } = await run(getServices(c).getPhoto(guest, c.req.param("id")));
      return new Response(object.body, {
        headers: { "content-type": photo.contentType, "cache-control": "private, max-age=3600" },
      });
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError("Could not load photo.");
      return jsonError(appError.message, appError.status);
    }
  });

  app.post("/api/logout", (c) => {
    setCookie(c, SESSION_COOKIE, "", { path: "/", maxAge: 0 });
    return json(c, OkResponse, { ok: true });
  });

  app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

  return app;
};
