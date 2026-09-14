import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { WorkerBindings } from './env';
import { SqlSessionRepository } from './repositories/sql-session-repository';
import { createCloudflarePersistence } from './runtime/cloudflare/persistence';

const encoder = new TextEncoder();
export const SESSION_COOKIE = 'tpm_session';
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function generateSessionToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return base64UrlEncode(new Uint8Array(digest));
}

export function getSessionToken(c: Context<any>): string | null {
  return getCookie(c, SESSION_COOKIE) ?? null;
}

export function setSessionCookie(c: Context<any>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: c.env.APP_ENV === 'production',
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(c: Context<any>): void {
  deleteCookie(c, SESSION_COOKIE, {
    secure: c.env.APP_ENV === 'production',
    sameSite: 'Strict',
    path: '/',
  });
}

function sessionRepository(c: Context<any>) {
  const { database } = createCloudflarePersistence(c.env);
  return new SqlSessionRepository(database);
}

export async function createSession(
  c: Context<any>,
  memberId: string,
  sessionVersion: number,
): Promise<string> {
  const token = generateSessionToken();
  const tokenHash = await hashSessionToken(token);
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  await sessionRepository(c).create({
    id: crypto.randomUUID(),
    memberId,
    tokenHash,
    sessionVersion,
    createdAt: nowIso,
    lastSeenAt: nowIso,
    expiresAt,
  });
  setSessionCookie(c, token);
  return token;
}

export async function revokeSessionToken(c: Context<any>, token: string): Promise<void> {
  const tokenHash = await hashSessionToken(token);
  await sessionRepository(c).revokeByTokenHash(tokenHash, new Date().toISOString());
}

export async function revokeAllMemberSessions(c: Context<any>, memberId: string): Promise<void> {
  await sessionRepository(c).revokeAllForMember(memberId, new Date().toISOString());
}
