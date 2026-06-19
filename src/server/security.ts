import { Effect } from "effect";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { rateLimits } from "../db/schema";
import type { AppContext } from "./types";
import { AppError } from "./types";

export const securityHeaders = async (c: AppContext, next: () => Promise<void>) => {
  c.header(
    "content-security-policy",
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
  );
  c.header("referrer-policy", "no-referrer");
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
  c.header("permissions-policy", "camera=(self), geolocation=(), microphone=(), payment=()");
  await next();
};

export const clientId = (c: AppContext) =>
  c.req.header("cf-connecting-ip") ??
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
  "unknown";

export const enforceRateLimit = (
  c: AppContext,
  scope: string,
  limit: number,
  windowSeconds: number,
) =>
  Effect.tryPromise({
    try: async () => {
      const now = Date.now();
      const windowMs = windowSeconds * 1000;
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const key = `${scope}:${clientId(c)}:${windowStart}`;
      const expiresAt = windowStart + windowMs * 2;

      const db = drizzle(c.env.DB);
      await db
        .insert(rateLimits)
        .values({ key, count: 1, windowStart, expiresAt })
        .onConflictDoUpdate({
          target: rateLimits.key,
          set: { count: sql`${rateLimits.count} + 1`, expiresAt },
        });

      const [row] = await db
        .select({ count: rateLimits.count })
        .from(rateLimits)
        .where(eq(rateLimits.key, key))
        .limit(1);

      if ((row?.count ?? 1) > limit)
        throw new AppError("Too many requests. Please wait a moment.", 429);

      if (now % 20 === 0) {
        c.executionCtx.waitUntil(
          db.delete(rateLimits).where(sql`${rateLimits.expiresAt} < ${now}`),
        );
      }
    },
    catch: (error) => (error instanceof AppError ? error : new AppError("Too many requests.", 429)),
  });

export const isImage = (contentType: string, bytes: Uint8Array) => {
  if (contentType === "image/jpeg")
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png")
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (contentType === "image/gif")
    return bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
  if (contentType === "image/webp") {
    return (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }
  return false;
};
