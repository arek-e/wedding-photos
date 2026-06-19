# Wedding Photos

A simple Cloudflare wedding photo camera. Guests join with a room code from a QR link, identify themselves by phone number, and upload up to 20 photos each.

The app UI behaves like a camera: an animated remaining-shot counter sits on the bottom left, a center shutter opens the phone camera/photo picker, and a right-side Polaroid gallery has All and Yours tabs. Guests can swipe their own Polaroids away to delete photos they do not want to keep.

## Stack

- Cloudflare Workers for the website
- Cloudflare D1 for event rooms, guests, and photo metadata
- Cloudflare R2 for original image blobs
- Drizzle ORM for schema and queries
- Effect for the app service layer
- Hono for routing
- React, Motion, and Vite+ for the frontend

## Local Setup

1. Install the `vp` CLI with `curl -fsSL https://vite.plus | bash` if it is not already installed.
2. Open a new terminal so `vp` is on PATH.
3. Install dependencies with `vp install`.
4. Copy `.dev.vars.example` to `.dev.vars` and set `SESSION_SECRET` plus `ADMIN_PIN`.
5. Run D1 migrations locally with `vp run db:migrate:local`.
6. For frontend-only UI work, run `vp dev`.
7. For the full Worker, D1, R2, and API stack, run `vp build` and then `vp run worker:dev`.
8. Open `http://localhost:8787/admin` to create a room and QR code.

## Vite+ Commands

- `vp install` installs dependencies with the project package manager.
- `vp dev` starts the Vite frontend dev server.
- `vp check` formats, lints, and type-checks.
- `vp build` builds the production frontend into `dist`.
- `vp run worker:dev` starts Wrangler for the full Cloudflare app.
- `vp run deploy` builds and deploys the Worker.

## Cloudflare Setup

Create the resources:

```sh
wrangler d1 create wedding_photos_rooms
wrangler r2 bucket create wedding-photos
```

Update `wrangler.toml` with the D1 `database_id`, set production secrets, then run:

```sh
wrangler secret put SESSION_SECRET
wrangler secret put ADMIN_PIN
```

Then migrate and deploy:

```sh
vp run db:migrate:remote
vp run deploy
```

## QR Code

Use `/admin` to create an event room. It returns a QR code and join link like:

```text
https://your-domain.example/?code=LANAALEX
```

Guests still enter their name and phone number, but they do not need a password.
