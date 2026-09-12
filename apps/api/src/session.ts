import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { WorkerBindings } from './env';

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
  await c.env.DB.prepare(
    `INSERT INTO auth_sessions
     (id, member_id, token_hash, session_version, created_at, last_seen_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(crypto.randomUUID(), memberId, tokenHash, sessionVersion, nowIso, nowIso, expiresAt).run();
  setSessionCookie(c, token);
  return token;
}

export async function revokeSessionToken(db: D1Database, token: string): Promise<void> {
  const tokenHash = await hashSessionToken(token);
  await db.prepare(
    `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?`,
  ).bind(new Date().toISOString(), tokenHash).run();
}

export async function revokeAllMemberSessions(db: D1Database, memberId: string): Promise<void> {
  await db.prepare(
    `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE member_id = ? AND revoked_at IS NULL`,
  ).bind(new Date().toISOString(), memberId).run();
}
