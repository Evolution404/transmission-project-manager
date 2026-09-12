import type { Context, MiddlewareHandler } from 'hono';
import type { CurrentUser, MemberRole, MemberScope } from '@tpm/shared';
import { findMemberById } from './db';
import type { WorkerBindings } from './env';
import { clearSessionCookie, getSessionToken, hashSessionToken } from './session';

type AppVariables = { currentUser: CurrentUser };
type AppEnv = { Bindings: WorkerBindings; Variables: AppVariables };

interface SessionRow {
  member_id: string;
  session_version: number;
  member_session_version: number;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}

function authError(c: Context<AppEnv>, code: string, message: string, status: 401 | 403 | 503 = 401) {
  return c.json({ ok: false as const, error: { code, message } }, status);
}

const passwordChangeAllowedPaths = new Set([
  '/api/me',
  '/api/auth/change-password',
  '/api/auth/logout',
]);

export const requireAuthentication: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getSessionToken(c);
  if (!token) return authError(c, 'UNAUTHENTICATED', '请先登录');

  const tokenHash = await hashSessionToken(token);
  const session = await c.env.DB.prepare(
    `SELECT s.member_id, s.session_version, s.last_seen_at, s.expires_at, s.revoked_at,
            m.session_version AS member_session_version
     FROM auth_sessions s
     INNER JOIN members m ON m.id = s.member_id
     WHERE s.token_hash = ? LIMIT 1`,
  ).bind(tokenHash).first<SessionRow>();

  const now = new Date();
  if (!session || session.revoked_at || session.expires_at <= now.toISOString() || session.session_version !== session.member_session_version) {
    clearSessionCookie(c);
    return authError(c, 'UNAUTHENTICATED', '登录状态已失效，请重新登录');
  }

  const member = await findMemberById(c.env.DB, session.member_id);
  if (!member) {
    clearSessionCookie(c);
    return authError(c, 'UNAUTHENTICATED', '登录状态已失效，请重新登录');
  }
  if (!member.enabled) return authError(c, 'MEMBER_DISABLED', '当前账号已停用', 403);

  const staleBefore = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  if (session.last_seen_at < staleBefore) {
    await c.env.DB.prepare(
      `UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ? AND last_seen_at < ? AND revoked_at IS NULL`,
    ).bind(now.toISOString(), tokenHash, staleBefore).run();
  }

  const currentUser: CurrentUser = { ...member, authSource: 'session' };
  c.set('currentUser', currentUser);
  if (currentUser.mustChangePassword && !passwordChangeAllowedPaths.has(c.req.path)) {
    return authError(c, 'PASSWORD_CHANGE_REQUIRED', '首次登录必须先修改密码', 403);
  }
  await next();
};

export function requireRoles(...roles: MemberRole[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('currentUser');
    if (!roles.includes(user.role)) {
      return authError(c, 'FORBIDDEN', '当前角色没有此操作权限', 403);
    }
    await next();
  };
}

export function hasScope(scopes: MemberScope[], type: Exclude<MemberScope['type'], 'all'>, id: string): boolean {
  return scopes.some((scope) => scope.type === 'all' || (scope.type === type && scope.id === id));
}

export function requireScope(type: Exclude<MemberScope['type'], 'all'>, paramName: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('currentUser');
    if (user.role === 'admin') {
      await next();
      return;
    }
    const id = c.req.param(paramName);
    if (!id || !hasScope(user.scopes, type, id)) {
      return authError(c, 'SCOPE_FORBIDDEN', '当前成员无权访问该业务范围', 403);
    }
    await next();
  };
}

export type { AppEnv, AppVariables };
