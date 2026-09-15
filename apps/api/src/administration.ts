import { Hono, type Context } from 'hono';
import {
  MEMBER_ROLES,
  type CreateMemberRequest,
  type MemberRole,
  type MemberScope,
  type ResetPasswordRequest,
  type UpdateMemberRequest,
  type UpdateSettingRequest,
} from '@tpm/shared';
import { hasScope, requireRoles, type AppEnv } from './auth.ts';
import { authRepositories, requireCredentialPepper } from './authentication-context.ts';
import { credentialParamsJson, credentialVerifier, normalizeUsername, validateDerivedCredential } from './credential.ts';
import { replayIdempotentResponse, requestHash, requireIdempotencyKey } from './http/idempotent-mutation.ts';
import { apiError } from './http/request-values.ts';
import { SqlSystemConfigRepository } from './repositories/sql-system-config-repository.ts';
import { resolvePersistence } from './runtime/persistence.ts';

export const administrationApp = new Hono<AppEnv>();

function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === 'string' && MEMBER_ROLES.includes(value as MemberRole);
}

function normalizeScopes(value: unknown, role: MemberRole): MemberScope[] | null {
  if (role === 'admin') return [{ type: 'all', id: null }];
  if (!Array.isArray(value)) return null;
  const scopes: MemberScope[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return null;
    const scope = candidate as Partial<MemberScope>;
    if (scope.type !== 'all' && scope.type !== 'framework' && scope.type !== 'project') return null;
    const id = scope.type === 'all' ? null : typeof scope.id === 'string' ? scope.id.trim() : '';
    if (scope.type !== 'all' && (!id || id.length > 120)) return null;
    if (scope.type === 'all' && scope.id !== null && scope.id !== undefined) return null;
    const key = `${scope.type}:${id ?? ''}`;
    if (!seen.has(key)) {
      scopes.push({ type: scope.type, id });
      seen.add(key);
    }
  }
  if (scopes.some((scope) => scope.type === 'all') && scopes.length !== 1) return null;
  return scopes;
}

function systemConfigRepository(c: Context<AppEnv>) {
  const { database } = resolvePersistence(c.env);
  return new SqlSystemConfigRepository(database);
}

administrationApp.get('/members', requireRoles('admin'), async (c) => {
  c.header('Cache-Control', 'no-store');
  const { members } = authRepositories(c);
  return c.json({ ok: true as const, data: { items: await members.list() } });
});

administrationApp.post('/members', requireRoles('admin'), async (c) => {
  const idempotency = requireIdempotencyKey(c);
  if (idempotency instanceof Response) return idempotency;
  const pepper = requireCredentialPepper(c);
  if (pepper instanceof Response) return pepper;

  let body: CreateMemberRequest;
  try { body = await c.req.json<CreateMemberRequest>(); } catch {
    return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400);
  }
  const username = normalizeUsername(body.username);
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (!username) return c.json(apiError('INVALID_USERNAME', '账号需为 3-64 位字母、数字、点、横线或下划线'), 422);
  if (!displayName || displayName.length > 80) return c.json(apiError('INVALID_DISPLAY_NAME', '成员名称不能为空且最多 80 个字符'), 422);
  if (!validateDerivedCredential(body)) return c.json(apiError('INVALID_CREDENTIAL', '认证凭据格式无效'), 422);
  if (!isMemberRole(body.role)) return c.json(apiError('INVALID_ROLE', '成员角色无效'), 422);
  const scopes = normalizeScopes(body.scopes, body.role);
  if (!scopes) return c.json(apiError('INVALID_SCOPES', '授权范围格式无效'), 422);

  const normalizedBody = { username, displayName, role: body.role, enabled: body.enabled !== false, scopes, salt: body.salt, credential: body.credential };
  const hash = await requestHash(normalizedBody);
  const operation = `members.create:${username}`;
  const replay = await replayIdempotentResponse(c, idempotency, operation, hash);
  if (replay) return replay;

  const verifier = await credentialVerifier(body.credential, pepper);
  const actor = c.get('currentUser');
  const memberId = crypto.randomUUID();
  const now = new Date().toISOString();
  const enabled = body.enabled === false ? 0 : 1;
  const data = {
    id: memberId,
    username,
    displayName,
    role: body.role,
    enabled: enabled === 1,
    version: 1,
    scopes,
    invitedAt: now,
    firstLoginAt: null,
    lastLoginAt: null,
    lifecycleStatus: enabled === 1 ? 'pending_first_login' as const : 'disabled' as const,
    mustChangePassword: true,
  };
  const response = { ok: true as const, data };
  const responseJson = JSON.stringify(response);

  const { memberAdmin } = authRepositories(c);
  try {
    await memberAdmin.createMember({
      memberId,
      username,
      displayName,
      role: body.role,
      enabled: enabled === 1,
      salt: body.salt,
      verifier,
      credentialParamsJson,
      nowIso: now,
      actorId: actor.id,
      scopes: scopes.map((scope) => ({ id: crypto.randomUUID(), type: scope.type, scopeId: scope.id })),
      auditEventId: crypto.randomUUID(),
      auditAfterJson: JSON.stringify(data),
      idempotency: {
        key: idempotency,
        operation,
        requestHash: hash,
        responseJson,
        statusCode: 201,
      },
    });
  } catch {
    if (await memberAdmin.usernameExists(username)) return c.json(apiError('USERNAME_EXISTS', '该账号已存在'), 409);
    return c.json(apiError('MEMBER_CREATE_FAILED', '账号创建失败，请刷新后重试'), 409);
  }
  return c.json(response, 201);
});

administrationApp.post('/members/:id/reset-password', requireRoles('admin'), async (c) => {
  const idempotency = requireIdempotencyKey(c);
  if (idempotency instanceof Response) return idempotency;
  const pepper = requireCredentialPepper(c);
  if (pepper instanceof Response) return pepper;
  let body: ResetPasswordRequest;
  try { body = await c.req.json<ResetPasswordRequest>(); } catch {
    return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400);
  }
  if (!validateDerivedCredential(body)) return c.json(apiError('INVALID_CREDENTIAL', '认证凭据格式无效'), 422);

  const { credentials, members } = authRepositories(c);
  const before = await members.findById(c.req.param('id'));
  const record = before ? await credentials.findByMemberId(before.id) : null;
  if (!before || !record) return c.json(apiError('MEMBER_NOT_FOUND', '成员不存在'), 404);
  const operation = `members.reset-password:${before.id}`;
  const hash = await requestHash(body);
  const replay = await replayIdempotentResponse(c, idempotency, operation, hash);
  if (replay) return replay;

  const verifier = await credentialVerifier(body.credential, pepper);
  const actor = c.get('currentUser');
  const now = new Date().toISOString();
  const nextSessionVersion = record.sessionVersion + 1;
  const data = { ...before, mustChangePassword: true };
  const response = { ok: true as const, data };
  await credentials.resetCredential({
    memberId: before.id,
    actorId: actor.id,
    salt: body.salt,
    verifier,
    paramsJson: credentialParamsJson,
    nextSessionVersion,
    nowIso: now,
    auditEventId: crypto.randomUUID(),
    idempotency: {
      key: idempotency,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
      statusCode: 200,
    },
  });
  return c.json(response);
});

administrationApp.patch('/members/:id', requireRoles('admin'), async (c) => {
  const idempotency = requireIdempotencyKey(c);
  if (idempotency instanceof Response) return idempotency;
  let body: UpdateMemberRequest;
  try { body = await c.req.json<UpdateMemberRequest>(); } catch {
    return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400);
  }
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) {
    return c.json(apiError('INVALID_VERSION', 'expectedVersion 必须是正整数'), 400);
  }
  if (body.role !== undefined && !isMemberRole(body.role)) return c.json(apiError('INVALID_ROLE', '成员角色无效'), 422);
  if (body.displayName !== undefined && (!body.displayName.trim() || body.displayName.trim().length > 80)) {
    return c.json(apiError('INVALID_DISPLAY_NAME', '成员名称不能为空且最多 80 个字符'), 422);
  }

  const operation = `members.patch:${c.req.param('id')}`;
  const hash = await requestHash(body);
  const replay = await replayIdempotentResponse(c, idempotency, operation, hash);
  if (replay) return replay;

  const { memberAdmin, members } = authRepositories(c);
  const before = await members.findById(c.req.param('id'));
  if (!before) return c.json(apiError('MEMBER_NOT_FOUND', '成员不存在'), 404);
  if (before.version !== body.expectedVersion) {
    return c.json(apiError('VERSION_CONFLICT', '成员已被其他人修改，请刷新后重试', { currentVersion: before.version }), 409);
  }

  const nextRole = body.role ?? before.role;
  const nextEnabled = body.enabled ?? before.enabled;
  const nextDisplayName = body.displayName?.trim() ?? before.displayName;
  const rawScopes = body.scopes ?? (before.role === 'admin' && nextRole !== 'admin' ? [] : before.scopes);
  const nextScopes = normalizeScopes(rawScopes, nextRole);
  if (!nextScopes) return c.json(apiError('INVALID_SCOPES', '授权范围格式无效'), 422);

  const protectsLastAdmin = before.enabled && before.role === 'admin' && (!nextEnabled || nextRole !== 'admin');
  const actor = c.get('currentUser');
  const now = new Date().toISOString();
  const nextVersion = before.version + 1;
  const invalidateSessions = before.enabled && !nextEnabled;
  const nextData = {
    ...before,
    displayName: nextDisplayName,
    role: nextRole,
    enabled: nextEnabled,
    version: nextVersion,
    scopes: nextScopes,
    lifecycleStatus: !nextEnabled ? 'disabled' as const : before.firstLoginAt ? 'active' as const : 'pending_first_login' as const,
  };
  const response = { ok: true as const, data: nextData };
  const responseJson = JSON.stringify(response);
  try {
    const result = await memberAdmin.updateMember({
      memberId: before.id,
      expectedVersion: before.version,
      displayName: nextDisplayName,
      role: nextRole,
      enabled: nextEnabled,
      protectsLastAdmin,
      invalidateSessions,
      nowIso: now,
      actorId: actor.id,
      scopes: nextScopes.map((scope) => ({ id: crypto.randomUUID(), type: scope.type, scopeId: scope.id })),
      auditEventId: crypto.randomUUID(),
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify(nextData),
      idempotency: {
        key: idempotency,
        operation,
        requestHash: hash,
        responseJson,
        statusCode: 200,
      },
    });
    if (result === 'last_admin') return c.json(apiError('LAST_ADMIN_REQUIRED', '不能停用或降权最后一个启用管理员'), 422);
    if (result === 'version_conflict') return c.json(apiError('VERSION_CONFLICT', '成员已被其他人修改，请刷新后重试'), 409);
  } catch {
    return c.json(apiError('MEMBER_UPDATE_FAILED', '成员更新失败，请刷新后重试'), 409);
  }
  return c.json(response);
});

administrationApp.get('/settings', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true as const, data: { items: await systemConfigRepository(c).listCurrentSettings() } });
});

administrationApp.get('/settings/:key/history', requireRoles('admin'), async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true as const, data: { items: await systemConfigRepository(c).getSettingHistory(c.req.param('key')) } });
});

administrationApp.put('/settings/:key', requireRoles('admin'), async (c) => {
  const idempotency = requireIdempotencyKey(c);
  if (idempotency instanceof Response) return idempotency;
  let body: UpdateSettingRequest;
  try { body = await c.req.json<UpdateSettingRequest>(); } catch {
    return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400);
  }
  if (body.expectedVersion !== null && (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1)) {
    return c.json(apiError('INVALID_VERSION', 'expectedVersion 必须为 null 或正整数'), 400);
  }
  const key = c.req.param('key').trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(key)) return c.json(apiError('INVALID_SETTING_KEY', '配置键格式无效'), 422);

  let valueJson: string;
  try { valueJson = JSON.stringify(body.value); } catch {
    return c.json(apiError('INVALID_SETTING_VALUE', '配置值无法序列化为 JSON'), 422);
  }
  if (valueJson === undefined || valueJson.length > 32_000) {
    return c.json(apiError('INVALID_SETTING_VALUE', '配置值不能为空且序列化后不得超过 32KB'), 422);
  }

  const hash = await requestHash(body);
  const operation = `settings.put:${key}`;
  const replay = await replayIdempotentResponse(c, idempotency, operation, hash);
  if (replay) return replay;
  const repository = systemConfigRepository(c);
  const currentVersion = await repository.currentSettingVersion(key);
  if (currentVersion !== body.expectedVersion) {
    return c.json(apiError('VERSION_CONFLICT', '配置版本已变化，请刷新后重试', { currentVersion }), 409);
  }

  const actor = c.get('currentUser');
  const now = new Date().toISOString();
  const nextVersion = (currentVersion ?? 0) + 1;
  const id = crypto.randomUUID();
  const effectiveFrom = body.effectiveFrom ?? now;
  if (Number.isNaN(Date.parse(effectiveFrom))) return c.json(apiError('INVALID_EFFECTIVE_FROM', 'effectiveFrom 必须是有效时间'), 422);
  const data = { id, key, version: nextVersion, value: body.value, effectiveFrom, createdBy: actor.id, createdAt: now };
  const response = { ok: true as const, data };
  try {
    await repository.createSettingVersion(
      { id, key, version: nextVersion, valueJson, effectiveFrom, createdBy: actor.id, createdAt: now },
      {
        auditId: crypto.randomUUID(),
        actorId: actor.id,
        beforeJson: JSON.stringify({ version: currentVersion }),
        afterJson: JSON.stringify(data),
        idempotencyKey: idempotency,
        operation,
        requestHash: hash,
        responseJson: JSON.stringify(response),
        statusCode: 200,
      },
    );
  } catch {
    return c.json(apiError('VERSION_CONFLICT', '配置已被并发修改，请刷新后重试'), 409);
  }
  return c.json(response);
});

administrationApp.get('/dictionaries', async (c) => {
  const key = c.req.query('key')?.trim();
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true as const, data: { items: await systemConfigRepository(c).listDictionary(key || undefined) } });
});

administrationApp.get('/scopes/:scopeType/:scopeId/check', async (c) => {
  const scopeType = c.req.param('scopeType');
  if (scopeType !== 'framework' && scopeType !== 'project') {
    return c.json(apiError('INVALID_SCOPE_TYPE', 'scopeType 必须是 framework 或 project'), 400);
  }
  const user = c.get('currentUser');
  if (user.role !== 'admin' && !hasScope(user.scopes, scopeType, c.req.param('scopeId'))) {
    return c.json(apiError('SCOPE_FORBIDDEN', '当前成员无权访问该业务范围'), 403);
  }
  return c.json({ ok: true as const, data: { allowed: true } });
});
