# Wedding Photos

A simple Cloudflare wedding photo gallery. Guests join with a Kahoot-style room code from a QR link, identify themselves by phone number, and upload up to 20 photos each.

## Stack

- Cloudflare Workers for the website
- Cloudflare D1 for guests and photo metadata
- Cloudflare R2 for original image blobs
- Drizzle ORM for schema and queries
- Effect for the app service layer
- Hono for routing

## Local Setup

1. Install dependencies with `bun install`.
2. Copy `.dev.vars.example` to `.dev.vars` and set `SESSION_SECRET`.
3. Run D1 migrations locally with `bun run db:migrate:local`.
4. Start the app with `bun run dev`.
5. Open `http://localhost:8787/?code=WEDDING`.

## Cloudflare Setup

Create the resources:

```sh
wrangler d1 create wedding_photos
wrangler r2 bucket create wedding-photos
```

Update `wrangler.toml` with the D1 `database_id`, set production secrets/vars, then run:

```sh
bun run db:migrate:remote
bun run deploy
```

## QR Code

Point the wedding QR code at the deployed URL with the code prefilled:

```text
https://your-domain.example/?code=WEDDING
```

Guests still enter their name and phone number, but they do not need a password.
