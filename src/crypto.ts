// Token and signing helpers. The same QR token algorithm is mirrored in
// public/present.js, which computes tokens in the lecturer's browser.

export const WINDOW_MS = 5_000;
export const TICKET_MS = 3 * 60_000;

const enc = new TextEncoder();

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomId(bytes = 16): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hmac(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function currentWindow(now = Date.now()): number {
  return Math.floor(now / WINDOW_MS);
}

/** The short token shown in the QR code for one sheet and one 5-second window. */
export async function qrToken(secret: string, sheetId: string, window: number): Promise<string> {
  return (await hmac(secret, `${sheetId}.${window}`)).slice(0, 11);
}

/**
 * A token is accepted for the current window and the one before it, so a
 * code that rotated while the camera was focusing still works (about 5-10 s).
 */
export async function verifyQrToken(
  secret: string,
  sheetId: string,
  windowStr: string,
  token: string,
  now = Date.now(),
): Promise<boolean> {
  const window = parseInt(windowStr, 36);
  if (!Number.isFinite(window)) return false;
  const cur = currentWindow(now);
  if (window !== cur && window !== cur - 1) return false;
  return timingSafeEqual(await qrToken(secret, sheetId, window), token);
}
