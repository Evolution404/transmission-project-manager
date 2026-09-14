import type { Context, MiddlewareHandler } from 'hono';
import type { CurrentUser, MemberRole, MemberScope } from '@tpm/shared';
import type { WorkerBindings } from './env';
import { SqlMemberRepository } from './repositories/sql-member-repository';
import { SqlSessionRepository } from './repositories/sql-session-repository';
import { createCloudflarePersistence } from './runtime/cloudflare/persistence';
import { clearSessionCookie, getSessionToken, hashSessionToken } from './session';

type AppVariables = { currentUser: CurrentUser };
type AppEnv = { Bindings: WorkerBindings; Variables: AppVariables };

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
  const { database } = createCloudflarePersistence(c.env);
  const sessions = new SqlSessionRepository(database);
  const members = new SqlMemberRepository(database);
  const session = await sessions.findByTokenHash(tokenHash);

  const now = new Date();
  if (!session || session.revokedAt || session.expiresAt <= now.toISOString() || session.sessionVersion !== session.memberSessionVersion) {
    clearSessionCookie(c);
    return authError(c, 'UNAUTHENTICATED', '登录状态已失效，请重新登录');
  }

  const member = await members.findById(session.memberId);
  if (!member) {
    clearSessionCookie(c);
    return authError(c, 'UNAUTHENTICATED', '登录状态已失效，请重新登录');
  }
  if (!member.enabled) return authError(c, 'MEMBER_DISABLED', '当前账号已停用', 403);

  const staleBefore = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  if (session.lastSeenAt < staleBefore) {
    await sessions.touchLastSeen(tokenHash, now.toISOString(), staleBefore);
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
