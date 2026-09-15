import type { Context } from 'hono';
import type { AppEnv } from './auth.ts';
import { apiError } from './http/request-values.ts';
import { SqlCredentialRepository } from './repositories/sql-credential-repository.ts';
import { SqlMemberAdminRepository } from './repositories/sql-member-admin-repository.ts';
import { SqlMemberRepository } from './repositories/sql-member-repository.ts';
import { resolvePersistence } from './runtime/persistence.ts';

export function requireCredentialPepper(c: Context<AppEnv>): string | Response {
  const pepper = c.env.AUTH_CREDENTIAL_PEPPER?.trim();
  if (!pepper) return c.json(apiError('AUTH_CONFIG_MISSING', '系统认证密钥未配置'), 503);
  return pepper;
}

export function currentUserData<T extends { mustChangePassword: boolean }>(member: T) {
  return { ...member, authSource: 'session' as const };
}

export function authRepositories(c: Context<AppEnv>) {
  const { database } = resolvePersistence(c.env);
  return {
    credentials: new SqlCredentialRepository(database),
    memberAdmin: new SqlMemberAdminRepository(database),
    members: new SqlMemberRepository(database),
  };
}
