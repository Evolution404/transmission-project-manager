import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Context, MiddlewareHandler } from 'hono';
import type { CurrentUser, MemberRole, MemberScope } from '@tpm/shared';
import { findMemberByEmail } from './db';
import type { WorkerBindings } from './env';

type AppVariables = { currentUser: CurrentUser };
type AppEnv = { Bindings: WorkerBindings; Variables: AppVariables };

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function normalizeTeamDomain(value: string): string {
  return value.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function unauthorized(c: Context<AppEnv>, code: string, message: string, status: 401 | 403 | 503 = 401) {
  return c.json({ ok: false as const, error: { code, message } }, status);
}

async function accessEmail(c: Context<AppEnv>): Promise<string | null> {
  const teamDomain = c.env.ACCESS_TEAM_DOMAIN?.trim();
  const audience = c.env.ACCESS_AUD?.trim();
  if (!teamDomain || !audience) return null;

  const assertion = c.req.header('Cf-Access-Jwt-Assertion');
  if (!assertion) throw new Error('ACCESS_ASSERTION_MISSING');

  const host = normalizeTeamDomain(teamDomain);
  const issuer = `https://${host}`;
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, jwks);
  }

  const { payload } = await jwtVerify(assertion, jwks, { issuer, audience });
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email) throw new Error('ACCESS_EMAIL_MISSING');
  return email;
}

function developmentEmail(c: Context<AppEnv>): string | null {
  if (c.env.APP_ENV !== 'development' && c.env.APP_ENV !== 'test') return null;
  const fromHeader = c.req.header('X-Dev-User-Email')?.trim().toLowerCase();
  const configured = c.env.DEV_AUTH_EMAIL?.trim().toLowerCase();
  return fromHeader || configured || null;
}

export const requireAuthentication: MiddlewareHandler<AppEnv> = async (c, next) => {
  let email: string | null = null;
  let authSource: CurrentUser['authSource'] = 'cloudflare-access';

  if (c.env.APP_ENV === 'production') {
    if (!c.env.ACCESS_TEAM_DOMAIN?.trim() || !c.env.ACCESS_AUD?.trim()) {
      return unauthorized(c, 'AUTH_CONFIG_MISSING', '生产环境缺少 Cloudflare Access 配置', 503);
    }
    try {
      email = await accessEmail(c);
    } catch {
      return unauthorized(c, 'UNAUTHENTICATED', 'Cloudflare Access 身份验证失败');
    }
  } else {
    email = developmentEmail(c);
    authSource = 'development';
    if (!email && c.env.ACCESS_TEAM_DOMAIN?.trim() && c.env.ACCESS_AUD?.trim()) {
      try {
        email = await accessEmail(c);
        authSource = 'cloudflare-access';
      } catch {
        return unauthorized(c, 'UNAUTHENTICATED', '身份验证失败');
      }
    }
    if (!email) return unauthorized(c, 'UNAUTHENTICATED', '本地开发身份未配置');
  }

  if (!email) return unauthorized(c, 'UNAUTHENTICATED', '身份验证失败');

  const member = await findMemberByEmail(c.env.DB, email);
  if (!member) return unauthorized(c, 'MEMBER_NOT_FOUND', '当前身份未加入系统成员', 403);
  if (!member.enabled) return unauthorized(c, 'MEMBER_DISABLED', '当前成员已停用', 403);

  c.set('currentUser', { ...member, authSource });
  await next();
};

export function requireRoles(...roles: MemberRole[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('currentUser');
    if (!roles.includes(user.role)) {
      return unauthorized(c, 'FORBIDDEN', '当前角色没有此操作权限', 403);
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
      return unauthorized(c, 'SCOPE_FORBIDDEN', '当前成员无权访问该业务范围', 403);
    }
    await next();
  };
}

export type { AppEnv, AppVariables };
