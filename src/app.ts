import { count, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Effect } from "effect";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import { nanoid } from "nanoid";
import { guests, photos, type Guest, type Photo } from "./db/schema";

type Env = {
  Bindings: {
    DB: D1Database;
    PHOTOS: R2Bucket;
    EVENT_CODE: string;
    SESSION_SECRET: string;
  };
};

const app = new Hono<Env>();

const MAX_PHOTOS_PER_GUEST = 20;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const SESSION_COOKIE = "wedding_guest";

type GuestSession = { guestId: string; phone: string };

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

const escapeHtml = (value: string) =>
  value.replace(/[&<>'"]/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] ?? char,
  );

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
  const payload = btoa(JSON.stringify({ guestId: guest.id, phone: guest.phone }));
  return `${payload}.${await sign(payload, secret)}`;
};

const readSession = async (cookie: string | undefined, secret: string): Promise<GuestSession | null> => {
  if (!cookie) return null;
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature || (await sign(payload, secret)) !== signature) return null;

  try {
    const parsed = JSON.parse(atob(payload)) as { guestId?: string; phone?: string };
    if (!parsed.guestId || !parsed.phone) return null;
    return { guestId: parsed.guestId, phone: parsed.phone };
  } catch {
    return null;
  }
};

const getCurrentGuest = (env: Env["Bindings"], cookie: string | undefined) =>
  Effect.tryPromise({
    try: async () => {
      const session = await readSession(cookie, env.SESSION_SECRET);
      if (!session) return null;

      const db = drizzle(env.DB);
      const guestId = session.guestId;
      const [guest] = await db.select().from(guests).where(eq(guests.id, guestId)).limit(1);
      return guest ?? null;
    },
    catch: () => new AppError("Could not read your session.", 401),
  });

const findOrCreateGuest = (env: Env["Bindings"], input: { name: string; phone: string }) =>
  Effect.tryPromise({
    try: async () => {
      const db = drizzle(env.DB);
      const phone = normalizePhone(input.phone);
      const name = input.name.trim();

      if (name.length < 2) throw new AppError("Please enter your name.");
      if (phone.length < 7) throw new AppError("Please enter a valid phone number.");

      const [existing] = await db.select().from(guests).where(eq(guests.phone, phone)).limit(1);
      if (existing) return existing;

      const guest: Guest = { id: nanoid(), name, phone, createdAt: new Date() };
      await db.insert(guests).values(guest);
      return guest;
    },
    catch: (error) => (error instanceof AppError ? error : new AppError("Could not create guest account.", 500)),
  });

const listGallery = (env: Env["Bindings"]): Effect.Effect<Array<Photo & { guestName: string }>, AppError, never> =>
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
        .orderBy(desc(photos.createdAt));

      return rows;
    },
    catch: () => new AppError("Could not load gallery.", 500),
  });

const countGuestPhotos = (env: Env["Bindings"], guestId: string): Effect.Effect<number, AppError, never> =>
  Effect.tryPromise({
    try: async () => {
      const db = drizzle(env.DB);
      const [{ total }] = await db.select({ total: count() }).from(photos).where(eq(photos.guestId, guestId));
      return total;
    },
    catch: () => new AppError("Could not check your upload limit.", 500),
  });

const savePhoto = (env: Env["Bindings"], guest: Guest, file: File): Effect.Effect<void, AppError, never> =>
  Effect.tryPromise({
    try: async () => {
      if (!file.type.startsWith("image/")) throw new AppError("Please upload image files only.");
      if (file.size > MAX_FILE_SIZE) throw new AppError("Each photo must be 10MB or smaller.");

      const db = drizzle(env.DB);
      const [{ total }] = await db.select({ total: count() }).from(photos).where(eq(photos.guestId, guest.id));
      if (total >= MAX_PHOTOS_PER_GUEST) throw new AppError("You have already uploaded 20 photos.");

      const remaining = MAX_PHOTOS_PER_GUEST - total;
      if (remaining < 1) throw new AppError("You have already uploaded 20 photos.");

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
    catch: (error) => (error instanceof AppError ? error : new AppError("Could not upload photo.", 500)),
  });

const page = (body: unknown) => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Wedding Photos</title>
      <link rel="stylesheet" href="/styles.css" />
    </head>
    <body>
      ${body}
    </body>
  </html>`;

const loginPage = (eventCode: string, error?: string) =>
  page(html`<main class="login-shell">
    <section class="card hero-card">
      <p class="eyebrow">Wedding photo room</p>
      <h1>Share the night through your eyes.</h1>
      <p class="lede">Enter the wedding code from the QR sign, then upload up to 20 favorite photos from your phone.</p>
      ${error ? html`<p class="error">${error}</p>` : ""}
      <form method="post" action="/login" class="login-form">
        <label>
          Room code
          <input name="code" value="${eventCode}" autocomplete="one-time-code" required />
        </label>
        <label>
          Your name
          <input name="name" autocomplete="name" required />
        </label>
        <label>
          Phone number
          <input name="phone" type="tel" autocomplete="tel" required />
        </label>
        <button type="submit">Join gallery</button>
      </form>
    </section>
  </main>`);

const galleryPage = (guest: Guest, gallery: Array<Photo & { guestName: string }>, error?: string) => {
  const uploadedByGuest = gallery.filter((photo) => photo.guestId === guest.id).length;
  const remaining = Math.max(0, MAX_PHOTOS_PER_GUEST - uploadedByGuest);

  return page(html`<main class="gallery-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Welcome, ${guest.name}</p>
        <h1>Wedding gallery</h1>
      </div>
      <a href="/logout">Sign out</a>
    </header>

    <section class="card upload-card">
      <div>
        <h2>Upload your photos</h2>
        <p>${remaining} of ${MAX_PHOTOS_PER_GUEST} uploads remaining.</p>
      </div>
      ${error ? html`<p class="error">${error}</p>` : ""}
      <form method="post" action="/upload" enctype="multipart/form-data">
        <input name="photos" type="file" accept="image/*" multiple ${remaining === 0 ? "disabled" : ""} />
        <button type="submit" ${remaining === 0 ? "disabled" : ""}>Upload</button>
      </form>
    </section>

    <section class="photo-grid" aria-label="Guest photos">
      ${gallery.length === 0
        ? html`<div class="empty-state">No photos yet. Be the first to add one.</div>`
        : raw(
            gallery
              .map(
                (photo) => `<article class="photo-card">
                  <img src="/photo/${photo.id}" alt="${escapeHtml(photo.filename)}" loading="lazy" />
                  <footer>By ${escapeHtml(photo.guestName)}</footer>
                </article>`,
              )
              .join(""),
          )}
    </section>
  </main>`);
};

app.get("/styles.css", (c) =>
  c.text(
    `:root{color-scheme:light;--ink:#241613;--muted:#795f59;--paper:#fffaf4;--card:#ffffff;--accent:#9d4f36;--accent-dark:#713420;--line:#ead9ce}*{box-sizing:border-box}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(circle at top left,#ffe2c9,transparent 32rem),linear-gradient(135deg,#fffaf4,#f4ddd2);color:var(--ink);min-height:100vh}a{color:var(--accent-dark);font-weight:700}.login-shell,.gallery-shell{width:min(1120px,100%);margin:0 auto;padding:24px}.login-shell{display:grid;place-items:center;min-height:100vh}.card{background:rgba(255,255,255,.82);border:1px solid var(--line);border-radius:28px;box-shadow:0 24px 80px rgba(86,43,30,.16)}.hero-card{width:min(560px,100%);padding:34px}.eyebrow{text-transform:uppercase;letter-spacing:.16em;font-size:.76rem;color:var(--accent-dark);font-weight:800;margin:0 0 10px}h1{font-family:Georgia,serif;font-size:clamp(2.2rem,7vw,4.9rem);line-height:.9;margin:0}h2{font-family:Georgia,serif;font-size:2rem;margin:0}.lede{font-size:1.15rem;color:var(--muted);line-height:1.55}.login-form,.upload-card form{display:grid;gap:14px}label{display:grid;gap:8px;font-weight:800;color:var(--muted)}input{width:100%;border:1px solid var(--line);border-radius:16px;padding:14px 16px;font:inherit;background:var(--paper);color:var(--ink)}button{border:0;border-radius:999px;padding:15px 22px;background:var(--accent);color:white;font:inherit;font-weight:900;cursor:pointer}button:disabled,input:disabled{opacity:.5;cursor:not-allowed}.error{padding:12px 14px;border-radius:16px;background:#ffe8e0;color:#8f2818;font-weight:800}.topbar{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:24px 0 28px}.upload-card{padding:24px;margin-bottom:28px;display:grid;grid-template-columns:1fr minmax(280px,420px);gap:22px;align-items:center}.photo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:16px}.photo-card{overflow:hidden;border-radius:24px;background:var(--card);border:1px solid var(--line);box-shadow:0 18px 44px rgba(86,43,30,.12)}.photo-card img{width:100%;aspect-ratio:1;object-fit:cover;display:block}.photo-card footer{padding:12px 14px;color:var(--muted);font-weight:800}.empty-state{grid-column:1/-1;border:1px dashed var(--line);border-radius:24px;padding:44px;text-align:center;color:var(--muted);background:rgba(255,255,255,.5)}@media (max-width:720px){.login-shell,.gallery-shell{padding:16px}.hero-card{padding:24px;border-radius:22px}.topbar{align-items:flex-start;flex-direction:column}.upload-card{grid-template-columns:1fr}.photo-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.photo-card{border-radius:18px}}`,
    200,
    { "content-type": "text/css; charset=utf-8" },
  ),
);

app.get("/", async (c) => {
  const guest = await run(getCurrentGuest(c.env, getCookie(c, SESSION_COOKIE)));
  if (!guest) return c.html(loginPage(c.req.query("code") ?? ""));

  const gallery = await run(listGallery(c.env));
  return c.html(galleryPage(guest, gallery));
});

app.post("/login", async (c) => {
  const form = await c.req.formData();
  const code = String(form.get("code") ?? "").trim();
  const name = String(form.get("name") ?? "");
  const phone = String(form.get("phone") ?? "");

  if (code.toUpperCase() !== c.env.EVENT_CODE.toUpperCase()) {
    return c.html(loginPage(code, "That room code does not match this wedding."), 401);
  }

  try {
    const guest = await run(findOrCreateGuest(c.env, { name, phone }));
    setCookie(c, SESSION_COOKIE, await makeSession(guest, c.env.SESSION_SECRET), {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return c.redirect("/");
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError("Could not sign in.");
    c.status(appError.status as never);
    return c.html(loginPage(code, appError.message));
  }
});

app.post("/upload", async (c) => {
  const guest = await run(getCurrentGuest(c.env, getCookie(c, SESSION_COOKIE)));
  if (!guest) return c.redirect("/");

  try {
    const form = await c.req.raw.formData();
    const files = form.getAll("photos").filter((item): item is File => typeof item !== "string" && item.size > 0);
    if (files.length === 0) throw new AppError("Choose at least one photo.");

    const uploaded = await run(countGuestPhotos(c.env, guest.id));
    if (uploaded + files.length > MAX_PHOTOS_PER_GUEST) {
      throw new AppError(`You can upload ${MAX_PHOTOS_PER_GUEST - uploaded} more photo(s).`);
    }

    for (const file of files) {
      await run(savePhoto(c.env, guest, file));
    }

    return c.redirect("/");
  } catch (error) {
    const gallery = await run(listGallery(c.env));
    const appError = error instanceof AppError ? error : new AppError("Could not upload photo.");
    c.status(appError.status as never);
    return c.html(galleryPage(guest, gallery, appError.message));
  }
});

app.get("/photo/:id", async (c) => {
  const guest = await run(getCurrentGuest(c.env, getCookie(c, SESSION_COOKIE)));
  if (!guest) return c.redirect("/");

  const db = drizzle(c.env.DB);
  const [photo] = await db.select().from(photos).where(eq(photos.id, c.req.param("id"))).limit(1);
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

app.get("/logout", (c) => {
  setCookie(c, SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return c.redirect("/");
});

export default app;
