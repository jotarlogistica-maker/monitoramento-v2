import type { NextRequest } from "next/server";

export const AUTH_COOKIE_NAME = "app_auth";
export const AUTH_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const TOKEN_VERSION = "v1";

function getSecret(): string | null {
  const value = process.env.APP_PASSWORD;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

export function isAppPasswordConfigured(): boolean {
  return getSecret() !== null;
}

export function matchesAppPassword(candidate: unknown): boolean {
  const secret = getSecret();
  return !!secret && typeof candidate === "string" && constantTimeEqual(candidate, secret);
}

export async function createAuthToken(now = Date.now()): Promise<string> {
  const secret = getSecret();
  if (!secret) throw new Error("APP_PASSWORD não está configurada.");

  const expiresAt = now + AUTH_MAX_AGE_SECONDS * 1000;
  const payload = `${TOKEN_VERSION}.${expiresAt}`;
  return `${payload}.${await sign(payload, secret)}`;
}

export async function verifyAuthToken(token: string | undefined | null, now = Date.now()): Promise<boolean> {
  const secret = getSecret();
  if (!secret || !token) return false;

  const [version, expiresAtRaw, signature, extra] = token.split(".");
  if (extra !== undefined || version !== TOKEN_VERSION || !expiresAtRaw || !signature) return false;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;

  const expected = await sign(`${version}.${expiresAtRaw}`, secret);
  return constantTimeEqual(signature, expected);
}

export async function isAuthenticatedRequest(req: Pick<NextRequest, "cookies">): Promise<boolean> {
  return verifyAuthToken(req.cookies.get(AUTH_COOKIE_NAME)?.value);
}

export function authCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: AUTH_MAX_AGE_SECONDS,
    path: "/",
  };
}
