import type { Guest } from "../db/schema";

type GuestSession = { guestId: string; eventId: string; phone: string };

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

export const makeSession = async (guest: Guest, secret: string) => {
  const payload = btoa(
    JSON.stringify({ guestId: guest.id, eventId: guest.eventId, phone: guest.phone }),
  );
  return `${payload}.${await sign(payload, secret)}`;
};

export const readSession = async (
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
