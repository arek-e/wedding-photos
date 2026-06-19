import type { Context } from "hono";

export type Env = {
  Bindings: {
    ASSETS: Fetcher;
    DB: D1Database;
    PHOTOS: R2Bucket;
    EVENT_CODE?: string;
    SESSION_SECRET: string;
  };
};

export type AppContext = Context<Env>;

export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const MAX_PHOTOS_PER_GUEST = 20;
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const SESSION_COOKIE = "wedding_guest";
