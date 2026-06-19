import { and, count, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect } from "effect";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { nanoid } from "nanoid";
import { events, guests, photos, type Event, type Guest, type Photo } from "./db/schema";

type Env = {
  Bindings: {
    ASSETS: Fetcher;
    DB: D1Database;
    PHOTOS: R2Bucket;
    ADMIN_PIN?: string;
    EVENT_CODE?: string;
    SESSION_SECRET: string;
  };
};

const app = new Hono<Env>();

const MAX_PHOTOS_PER_GUEST = 20;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const SESSION_COOKIE = "wedding_guest";

type GuestSession = { guestId: string; eventId: string; phone: string };
type GalleryPhoto = Photo & { guestName: string; isMine: boolean };

class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const run = <A>(effect: Effect.Effect<A, unknown, never>) => Effect.runPromise(effect);

const normalizePhone = (phone: string) => phone.replace(/[^0-9+]/g, "").trim();
const normalizeCode = (code: string) =>
  code
    .replace(/[^a-zA-Z0-9-]/g, "")
    .toUpperCase()
    .trim();

const toHex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const sign = async (value: string, secret: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
};

const makeSession = async (guest: Guest, secret: string) => {
  const payload = btoa(
    JSON.stringify({ guestId: guest.id, eventId: guest.eventId, phone: guest.phone }),
  );
  return `${payload}.${await sign(payload, secret)}`;
};

const readSession = async (
  cookie: string | undefined,
  secret: string,
): Promise<GuestSession | null> => {
  if (!cookie) return null;
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature || (await sign(payload, secret)) !== signature) return null;

  try {
    const parsed = JSON.parse(atob(payload)) as {
      guestId?: string;
      eventId?: string;
      phone?: string;
    };
    if (!parsed.guestId || !parsed.eventId || !parsed.phone) return null;
    return { guestId: parsed.guestId, eventId: parsed.eventId, phone: parsed.phone };
  } catch {
    return null;
  }
};

const jsonError = (message: string, status = 400) => Response.json({ error: message }, { status });

const joinUrl = (requestUrl: string, code: string) => {
  const url = new URL(requestUrl);
  url.pathname = "/";
  url.search = new URLSearchParams({ code }).toString();
  return url.toString();
};

const getCurrentGuest = (env: Env["Bindings"], cookie: string | undefined) =>
  Effect.tryPromise({
    try: async () => {
      const session = await readSession(cookie, env.SESSION_SECRET);
      if (!session) return null;

      const db = drizzle(env.DB);
      const [guest] = await db.select().from(guests).where(eq(guests.id, session.guestId)).limit(1);
      return guest ?? null;
    },
    catch: () => new AppError("Could not read your session.", 401),
  });

const requireGuest = async (env: Env["Bindings"], cookie: string | undefined) => {
  const guest = await run(getCurrentGuest(env, cookie));
  if (!guest) throw new AppError("Please join the wedding room first.", 401);
  return guest;
};

const findOrCreateGuest = (
  env: Env["Bindings"],
  input: { code: string; name: string; phone: string },
) =>
  Effect.tryPromise({
    try: async () => {
      const db = drizzle(env.DB);
      const phone = normalizePhone(input.phone);
      const name = input.name.trim();
      const code = normalizeCode(input.code);

      if (name.length < 2) throw new AppError("Please enter your name.");
      if (phone.length < 7) throw new AppError("Please enter a valid phone number.");
      if (code.length < 3) throw new AppError("Please enter a room code.");

      const [event] = await db.select().from(events).where(eq(events.code, code)).limit(1);
      if (!event) throw new AppError("That room code does not match any wedding room.", 401);

      const [existing] = await db
        .select()
        .from(guests)
        .where(and(eq(guests.eventId, event.id), eq(guests.phone, phone)))
        .limit(1);
      if (existing) return existing;

      const guest: Guest = { id: nanoid(), eventId: event.id, name, phone, createdAt: new Date() };
      await db.insert(guests).values(guest);
      return guest;
    },
    catch: (error) =>
      error instanceof AppError ? error : new AppError("Could not create guest account.", 500),
  });

const listGallery = (
  env: Env["Bindings"],
  guest: Guest,
): Effect.Effect<GalleryPhoto[], AppError, never> =>
  Effect.tryPromise({
    try: async () => {
      const db = drizzle(env.DB);
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
  });

const createEvent = (
  env: Env["Bindings"],
  input: { name: string; code: string },
): Effect.Effect<Event, AppError, never> =>
  Effect.tryPromise({
    try: async () => {
      const db = drizzle(env.DB);
      const name = input.name.trim();
      const code = normalizeCode(input.code || name);

      if (name.length < 2) throw new AppError("Please enter an event name.");
      if (code.length < 3)
        throw new AppError("Please enter a room code with at least 3 characters.");

      const event: Event = { id: nanoid(), name, code, createdAt: new Date() };
      await db.insert(events).values(event);
      return event;
    },
    catch: (error) => {
      if (error instanceof AppError) return error;
      if (error instanceof Error && error.message.includes("UNIQUE"))
        return new AppError("That room code is already used.");
      return new AppError("Could not create room.", 500);
    },
  });

const countGuestPhotos = (
  env: Env["Bindings"],
  guestId: string,
): Effect.Effect<number, AppError, never> =>
  Effect.tryPromise({
    try: async () => {
      const db = drizzle(env.DB);
      const [{ total }] = await db
        .select({ total: count() })
        .from(photos)
        .where(eq(photos.guestId, guestId));
      return total;
    },
    catch: () => new AppError("Could not check your upload limit.", 500),
  });

const savePhoto = (
  env: Env["Bindings"],
  guest: Guest,
  file: File,
): Effect.Effect<void, AppError, never> =>
  Effect.tryPromise({
    try: async () => {
      if (!file.type.startsWith("image/")) throw new AppError("Please upload image files only.");
      if (file.size > MAX_FILE_SIZE) throw new AppError("Each photo must be 10MB or smaller.");

      const db = drizzle(env.DB);
      const [{ total }] = await db
        .select({ total: count() })
        .from(photos)
        .where(eq(photos.guestId, guest.id));
      if (total >= MAX_PHOTOS_PER_GUEST) throw new AppError("You have already uploaded 20 photos.");

      const id = nanoid();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "photo";
      const objectKey = `${guest.id}/${id}-${safeName}`;

      await env.PHOTOS.put(objectKey, file.stream(), {
        httpMetadata: { contentType: file.type },
        customMetadata: { guestId: guest.id, originalName: file.name },
      });

      await db.insert(photos).values({
        id,
        guestId: guest.id,
        objectKey,
        filename: file.name,
        contentType: file.type,
        size: file.size,
        createdAt: new Date(),
      });
    },
    catch: (error) =>
      error instanceof AppError ? error : new AppError("Could not upload photo.", 500),
  });

const serializePhoto = (photo: GalleryPhoto) => ({
  id: photo.id,
  guestName: photo.guestName,
  filename: photo.filename,
  size: photo.size,
  createdAt: photo.createdAt.toISOString(),
  isMine: photo.isMine,
  url: `/photo/${photo.id}`,
});

app.get("/api/session", async (c) => {
  const guest = await run(getCurrentGuest(c.env, getCookie(c, SESSION_COOKIE)));
  if (!guest) {
    return c.json({
      guest: null,
      eventCode: c.req.query("code") ?? c.env.EVENT_CODE ?? "",
      maxPhotos: MAX_PHOTOS_PER_GUEST,
    });
  }

  const uploaded = await run(countGuestPhotos(c.env, guest.id));
  return c.json({
    guest: { id: guest.id, name: guest.name, phone: guest.phone },
    eventCode: c.req.query("code") ?? "",
    maxPhotos: MAX_PHOTOS_PER_GUEST,
    remaining: Math.max(0, MAX_PHOTOS_PER_GUEST - uploaded),
  });
});

app.post("/api/login", async (c) => {
  const input = (await c.req.json().catch(() => ({}))) as {
    code?: string;
    name?: string;
    phone?: string;
  };
  const code = String(input.code ?? "").trim();

  try {
    const guest = await run(
      findOrCreateGuest(c.env, {
        code,
        name: String(input.name ?? ""),
        phone: String(input.phone ?? ""),
      }),
    );
    setCookie(c, SESSION_COOKIE, await makeSession(guest, c.env.SESSION_SECRET), {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return c.json({ guest: { id: guest.id, name: guest.name, phone: guest.phone } });
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError("Could not sign in.");
    return jsonError(appError.message, appError.status);
  }
});

app.get("/api/gallery", async (c) => {
  try {
    const guest = await requireGuest(c.env, getCookie(c, SESSION_COOKIE));
    const scope = c.req.query("scope") === "personal" ? "personal" : "all";
    const gallery = await run(listGallery(c.env, guest));
    const scoped = scope === "personal" ? gallery.filter((photo) => photo.isMine) : gallery;
    return c.json({ photos: scoped.map(serializePhoto) });
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError("Could not load gallery.");
    return jsonError(appError.message, appError.status);
  }
});

app.post("/api/admin/events", async (c) => {
  const input = (await c.req.json().catch(() => ({}))) as {
    adminPin?: string;
    name?: string;
    code?: string;
  };
  if (!c.env.ADMIN_PIN || input.adminPin !== c.env.ADMIN_PIN) {
    return jsonError("Admin PIN is required.", 401);
  }

  try {
    const event = await run(
      createEvent(c.env, { name: String(input.name ?? ""), code: String(input.code ?? "") }),
    );
    return c.json({ event, joinUrl: joinUrl(c.req.url, event.code) });
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError("Could not create room.");
    return jsonError(appError.message, appError.status);
  }
});

app.post("/api/upload", async (c) => {
  try {
    const guest = await requireGuest(c.env, getCookie(c, SESSION_COOKIE));
    const form = await c.req.raw.formData();
    const files = form
      .getAll("photos")
      .filter((item): item is File => typeof item !== "string" && item.size > 0);
    if (files.length === 0) throw new AppError("Choose at least one photo.");

    const uploaded = await run(countGuestPhotos(c.env, guest.id));
    if (uploaded + files.length > MAX_PHOTOS_PER_GUEST) {
      throw new AppError(`You can upload ${MAX_PHOTOS_PER_GUEST - uploaded} more photo(s).`);
    }

    for (const file of files) {
      await run(savePhoto(c.env, guest, file));
    }

    const remaining = Math.max(0, MAX_PHOTOS_PER_GUEST - uploaded - files.length);
    return c.json({ remaining });
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError("Could not upload photo.");
    return jsonError(appError.message, appError.status);
  }
});

app.delete("/api/photos/:id", async (c) => {
  try {
    const guest = await requireGuest(c.env, getCookie(c, SESSION_COOKIE));
    const db = drizzle(c.env.DB);
    const [photo] = await db
      .select()
      .from(photos)
      .where(eq(photos.id, c.req.param("id")))
      .limit(1);
    if (!photo) return c.notFound();
    if (photo.guestId !== guest.id) throw new AppError("You can only remove your own photos.", 403);

    await c.env.PHOTOS.delete(photo.objectKey);
    await db.delete(photos).where(eq(photos.id, photo.id));
    return c.json({ ok: true });
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError("Could not remove photo.");
    return jsonError(appError.message, appError.status);
  }
});

app.get("/photo/:id", async (c) => {
  const guest = await run(getCurrentGuest(c.env, getCookie(c, SESSION_COOKIE)));
  if (!guest) return jsonError("Please join the wedding room first.", 401);

  const db = drizzle(c.env.DB);
  const [photo] = await db
    .select()
    .from(photos)
    .where(eq(photos.id, c.req.param("id")))
    .limit(1);
  if (!photo) return c.notFound();

  const object = await c.env.PHOTOS.get(photo.objectKey);
  if (!object) return c.notFound();

  return new Response(object.body, {
    headers: {
      "content-type": photo.contentType,
      "cache-control": "private, max-age=3600",
    },
  });
});

app.post("/api/logout", (c) => {
  setCookie(c, SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return c.json({ ok: true });
});

app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
