import { Hono, type Context } from 'hono';
import {
  MEMBER_ROLES,
  type ApiError,
  type BootstrapAdminRequest,
  type ChangePasswordRequest,
  type CreateMemberRequest,
  type HealthResponse,
  type LoginKdfRequest,
  type LoginRequest,
  type MemberRole,
  type MemberScope,
  type ResetPasswordRequest,
  type UpdateMemberRequest,
  type UpdateSettingRequest,
} from '@tpm/shared';
import { hasScope, requireAuthentication, requireRoles, type AppEnv } from './auth';
import {
  countEnabledAdmins,
  countMembers,
  findCredentialByMemberId,
  findCredentialByUsername,
  findMemberById,
  getSettingHistory,
  listCurrentSettings,
  listDictionary,
  listMembers,
  recordSuccessfulLogin,
} from './db';
import {
  constantTimeEqualText,
  credentialDescriptor,
  credentialParamsJson,
  credentialVerifier,
  fakeSaltForUsername,
  fakeVerifierForUsername,
  normalizeUsername,
  validateCredentialValue,
  validateDerivedCredential,
} from './credential';
import {
  clearSessionCookie,
  createSession,
  getSessionToken,
  revokeSessionToken,
} from './session';
import { p2App } from './p2';
import { p3App } from './p3';
import { p4App } from './p4';
import { p5App } from './p5';

export const app = new Hono<AppEnv>();

const jsonHeaders = { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' };
const LOCK_AFTER_FAILURES = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

function apiError(code: string, message: string, details?: unknown): ApiError {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

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

async function requestHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requireCredentialPepper(c: Context<AppEnv>): string | Response {
  const pepper = c.env.AUTH_CREDENTIAL_PEPPER?.trim();
  if (!pepper) return c.json(apiError('AUTH_CONFIG_MISSING', '系统认证密钥未配置'), 503);
  return pepper;
}

async function replayIdempotentResponse(c: Context<AppEnv>, key: string, operation: string, hash: string) {
  const user = c.get('currentUser');
  const row = await c.env.DB.prepare(
    `SELECT actor_member_id, operation, request_hash, response_json, status_code
     FROM idempotency_records WHERE idempotency_key = ? LIMIT 1`,
  ).bind(key).first<{
    actor_member_id: string;
    operation: string;
    request_hash: string;
    response_json: string;
    status_code: number;
  }>();
  if (!row) return null;
  if (row.actor_member_id !== user.id || row.operation !== operation || row.request_hash !== hash) {
    return c.json(apiError('IDEMPOTENCY_CONFLICT', '该 Idempotency-Key 已用于不同请求'), 409);
  }
  return new Response(row.response_json, { status: row.status_code, headers: jsonHeaders });
}

function requireIdempotencyKey(c: Context<AppEnv>): string | Response {
  const key = c.req.header('Idempotency-Key')?.trim();
  if (!key || key.length > 200) {
    return c.json(apiError('IDEMPOTENCY_KEY_REQUIRED', '变更请求必须提供有效的 Idempotency-Key'), 400);
  }
  return key;
}

function scopeStatements(
  c: Context<AppEnv>,
  memberId: string,
  scopes: MemberScope[],
  conditionVersion?: number,
  conditionUpdatedAt?: string,
) {
  const statements: D1PreparedStatement[] = [];
  for (const scope of scopes) {
    if (conditionVersion !== undefined && conditionUpdatedAt) {
      statements.push(c.env.DB.prepare(
        `INSERT INTO member_scopes (id, member_id, scope_type, scope_id, created_at)
         SELECT ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM members WHERE id = ? AND version = ? AND updated_at = ?)`,
      ).bind(
        crypto.randomUUID(), memberId, scope.type, scope.id, conditionUpdatedAt,
        memberId, conditionVersion, conditionUpdatedAt,
      ));
    } else {
      statements.push(c.env.DB.prepare(
        `INSERT INTO member_scopes (id, member_id, scope_type, scope_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), memberId, scope.type, scope.id, new Date().toISOString()));
    }
  }
  return statements;
}

function currentUserData<T extends { mustChangePassword: boolean }>(member: T) {
  return { ...member, authSource: 'session' as const };
}

app.get('/api/health', (c) => {
  const body: HealthResponse = {
    ok: true,
    data: { service: 'transmission-project-manager', stage: 'p5' },
  };
  c.header('Cache-Control', 'no-store');
  return c.json(body);
});

app.get('/api/auth/status', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true as const, data: { initialized: (await countMembers(c.env.DB)) > 0 } });
});

app.post('/api/auth/kdf', async (c) => {
  const pepper = requireCredentialPepper(c);
  if (pepper instanceof Response) return pepper;
  let body: LoginKdfRequest;
  try { body = await c.req.json<LoginKdfRequest>(); } catch {
    return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400);
  }
  const username = normalizeUsername(body.username);
  const credential = username ? await findCredentialByUsername(c.env.DB, username) : null;
  const salt = credential?.credentialSalt ?? await fakeSaltForUsername(username ?? 'invalid-user', pepper);
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true as const, data: credentialDescriptor(salt) });
});

app.post('/api/auth/bootstrap', async (c) => {
  const configured = c.env.BOOTSTRAP_TOKEN?.trim();
  const supplied = c.req.header('X-Bootstrap-Token')?.trim() ?? '';
  if (!configured || !supplied || !constantTimeEqualText(configured, supplied)) {
    return c.json(apiError('BOOTSTRAP_FORBIDDEN', '首管理员初始化凭据无效'), 403);
  }
  const pepper = requireCredentialPepper(c);
  if (pepper instanceof Response) return pepper;

  let body: BootstrapAdminRequest;
  try { body = await c.req.json<BootstrapAdminRequest>(); } catch {
    return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400);
  }
  const username = normalizeUsername(body.username);
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (!username) return c.json(apiError('INVALID_USERNAME', '账号需为 3-64 位字母、数字、点、横线或下划线'), 422);
  if (!displayName || displayName.length > 80) return c.json(apiError('INVALID_DISPLAY_NAME', '管理员名称不能为空且最多 80 个字符'), 422);
  if (!validateDerivedCredential(body)) return c.json(apiError('INVALID_CREDENTIAL', '认证凭据格式无效'), 422);
  if (await countMembers(c.env.DB) > 0) return c.json(apiError('BOOTSTRAP_CLOSED', '系统已有账号，首管理员初始化已关闭'), 409);

  const verifier = await credentialVerifier(body.credential, pepper);
  const memberId = crypto.randomUUID();
  const now = new Date().toISOString();
  const data = {
    id: memberId,
    username,
    displayName,
    role: 'admin' as const,
    enabled: true,
    version: 1,
    scopes: [{ type: 'all' as const, id: null }],
    invitedAt: now,
    firstLoginAt: now,
    lastLoginAt: now,
    lifecycleStatus: 'active' as const,
    mustChangePassword: false,
  };

  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO members
         (id,username,display_name,role,enabled,version,
          credential_salt,credential_verifier,credential_algorithm,credential_params_json,
          must_change_password,session_version,failed_login_count,locked_until,last_failed_login_at,
          credential_changed_at,invited_at,first_login_at,last_login_at,created_at,updated_at)
         SELECT ?,?,?,'admin',1,1,?,?,'argon2id-v1',?,0,1,0,NULL,NULL,?,?,?,?,?,?
         WHERE NOT EXISTS (SELECT 1 FROM members)`,
      ).bind(
        memberId, username, displayName, body.salt, verifier, credentialParamsJson,
        now, now, now, now, now, now,
      ),
      c.env.DB.prepare(
        `INSERT INTO member_scopes (id,member_id,scope_type,scope_id,created_at)
         SELECT ?,?,'all',NULL,? WHERE EXISTS (SELECT 1 FROM members WHERE id=?)`,
      ).bind(crypto.randomUUID(), memberId, now, memberId),
      c.env.DB.prepare(
        `INSERT INTO audit_events
         (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
         SELECT ?,NULL,'auth.bootstrap','member',?,NULL,?,?
         WHERE EXISTS (SELECT 1 FROM members WHERE id=?)`,
      ).bind(crypto.randomUUID(), memberId, JSON.stringify(data), now, memberId),
    ]);
    if (Number(results[0]?.meta.changes ?? 0) !== 1) {
      return c.json(apiError('BOOTSTRAP_CLOSED', '首管理员已被其他请求初始化'), 409);
    }
  } catch {
    return c.json(apiError('BOOTSTRAP_CLOSED', '首管理员初始化失败或已经完成'), 409);
  }

  await createSession(c, memberId, 1);
  return c.json({ ok: true as const, data: currentUserData(data) }, 201);
});

app.post('/api/auth/login', async (c) => {
  const pepper = requireCredentialPepper(c);
  if (pepper instanceof Response) return pepper;
  let body: LoginRequest;
  try { body = await c.req.json<LoginRequest>(); } catch {
    return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400);
  }
  const username = normalizeUsername(body.username);
  const generic = () => c.json(apiError('INVALID_CREDENTIALS', '账号或密码错误'), 401);
  if (!username || !validateCredentialValue(body.credential)) return generic();

  const record = await findCredentialByUsername(c.env.DB, username);
  const expected = record?.credentialVerifier ?? await fakeVerifierForUsername(username, pepper);
  const actual = await credentialVerifier(body.credential, pepper);
  const matches = constantTimeEqualText(actual, expected);
  const now = new Date();
  const nowIso = now.toISOString();

  if (!record) return generic();
  if (record.lockedUntil && record.lockedUntil > nowIso) return generic();
  if (!matches) {
    const failures = record.failedLoginCount + 1;
    const lockedUntil = failures >= LOCK_AFTER_FAILURES ? new Date(now.getTime() + LOCK_DURATION_MS).toISOString() : null;
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE members
         SET failed_login_count=?,locked_until=?,last_failed_login_at=?,updated_at=? WHERE id=?`,
      ).bind(failures, lockedUntil, nowIso, nowIso, record.memberId),
      c.env.DB.prepare(
        `INSERT INTO audit_events
         (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
         VALUES (?,NULL,'auth.login_failed','member',?,NULL,?,?)`,
      ).bind(crypto.randomUUID(), record.memberId, JSON.stringify({ failedLoginCount: failures, locked: Boolean(lockedUntil) }), nowIso),
    ]);
    return generic();
  }

  const member = await findMemberById(c.env.DB, record.memberId);
  if (!member) return generic();
  if (!member.enabled) return c.json(apiError('MEMBER_DISABLED', '当前账号已停用'), 403);

  await c.env.DB.prepare(
    `UPDATE members SET failed_login_count=0,locked_until=NULL,last_failed_login_at=NULL,updated_at=? WHERE id=?`,
  ).bind(nowIso, member.id).run();
  const activeMember = await recordSuccessfulLogin(c.env.DB, member);
  await createSession(c, member.id, record.sessionVersion);
  return c.json({ ok: true as const, data: currentUserData(activeMember) });
});

app.use('/api/*', async (c, next) => {
  const publicPaths = new Set(['/api/health', '/api/auth/status', '/api/auth/kdf', '/api/auth/bootstrap', '/api/auth/login']);
  if (publicPaths.has(c.req.path)) return next();
  return requireAuthentication(c, next);
});

app.get('/api/me', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true as const, data: c.get('currentUser') });
});

app.post('/api/auth/logout', async (c) => {
  const token = getSessionToken(c);
  if (token) await revokeSessionToken(c.env.DB, token);
  clearSessionCookie(c);
  return c.json({ ok: true as const, data: { loggedOut: true } });
});

app.post('/api/auth/change-password', async (c) => {
  const pepper = requireCredentialPepper(c);
  if (pepper instanceof Response) return pepper;
  let body: ChangePasswordRequest;
  try { body = await c.req.json<ChangePasswordRequest>(); } catch {
    return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400);
  }
  if (!validateCredentialValue(body.currentCredential) || !validateDerivedCredential(body.next)) {
    return c.json(apiError('INVALID_CREDENTIAL', '认证凭据格式无效'), 422);
  }

  const user = c.get('currentUser');
  const record = await findCredentialByMemberId(c.env.DB, user.id);
  if (!record) return c.json(apiError('MEMBER_NOT_FOUND', '成员不存在'), 404);
  const currentVerifier = await credentialVerifier(body.currentCredential, pepper);
  if (!constantTimeEqualText(currentVerifier, record.credentialVerifier)) {
    return c.json(apiError('INVALID_CURRENT_PASSWORD', '当前密码错误'), 401);
  }

  const nextVerifier = await credentialVerifier(body.next.credential, pepper);
  const now = new Date().toISOString();
  const nextSessionVersion = record.sessionVersion + 1;
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE members
       SET credential_salt=?,credential_verifier=?,credential_algorithm='argon2id-v1',credential_params_json=?,
           must_change_password=0,session_version=?,failed_login_count=0,locked_until=NULL,last_failed_login_at=NULL,
           credential_changed_at=?,updated_at=? WHERE id=?`,
    ).bind(body.next.salt, nextVerifier, credentialParamsJson, nextSessionVersion, now, now, user.id),
    c.env.DB.prepare(
      `UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE member_id=? AND revoked_at IS NULL`,
    ).bind(now, user.id),
    c.env.DB.prepare(
      `INSERT INTO audit_events
       (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
       VALUES (?,?,'auth.credential_change','member',?,NULL,?,?)`,
    ).bind(crypto.randomUUID(), user.id, user.id, JSON.stringify({ sessionVersion: nextSessionVersion }), now),
  ]);
  await createSession(c, user.id, nextSessionVersion);
  const refreshed = await findMemberById(c.env.DB, user.id);
  if (!refreshed) return c.json(apiError('MEMBER_NOT_FOUND', '成员不存在'), 404);
  return c.json({ ok: true as const, data: currentUserData(refreshed) });
});

app.get('/api/members', requireRoles('admin'), async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true as const, data: { items: await listMembers(c.env.DB) } });
});

app.post('/api/members', requireRoles('admin'), async (c) => {
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

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO members
         (id,username,display_name,role,enabled,version,
          credential_salt,credential_verifier,credential_algorithm,credential_params_json,
          must_change_password,session_version,failed_login_count,locked_until,last_failed_login_at,
          credential_changed_at,invited_at,first_login_at,last_login_at,created_at,updated_at)
         VALUES (?,?,?,?,?,1,?,?,'argon2id-v1',?,1,1,0,NULL,NULL,?,?,NULL,NULL,?,?)`,
      ).bind(
        memberId, username, displayName, body.role, enabled,
        body.salt, verifier, credentialParamsJson,
        now, now, now, now,
      ),
      ...scopeStatements(c, memberId, scopes),
      c.env.DB.prepare(
        `INSERT INTO audit_events
         (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
         VALUES (?,?,'member.create','member',?,NULL,?,?)`,
      ).bind(crypto.randomUUID(), actor.id, memberId, JSON.stringify(data), now),
      c.env.DB.prepare(
        `INSERT INTO idempotency_records
         (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
         VALUES (?,?,?,?,?,201,?)`,
      ).bind(idempotency, actor.id, operation, hash, responseJson, now),
    ]);
  } catch {
    const existing = await c.env.DB.prepare('SELECT id FROM members WHERE username=? COLLATE NOCASE LIMIT 1')
      .bind(username).first<{ id: string }>();
    if (existing) return c.json(apiError('USERNAME_EXISTS', '该账号已存在'), 409);
    return c.json(apiError('MEMBER_CREATE_FAILED', '账号创建失败，请刷新后重试'), 409);
  }
  return c.json(response, 201);
});

app.post('/api/members/:id/reset-password', requireRoles('admin'), async (c) => {
  const idempotency = requireIdempotencyKey(c);
  if (idempotency instanceof Response) return idempotency;
  const pepper = requireCredentialPepper(c);
  if (pepper instanceof Response) return pepper;
  let body: ResetPasswordRequest;
  try { body = await c.req.json<ResetPasswordRequest>(); } catch {
    return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400);
  }
  if (!validateDerivedCredential(body)) return c.json(apiError('INVALID_CREDENTIAL', '认证凭据格式无效'), 422);

  const before = await findMemberById(c.env.DB, c.req.param('id'));
  const record = before ? await findCredentialByMemberId(c.env.DB, before.id) : null;
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
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE members
       SET credential_salt=?,credential_verifier=?,credential_algorithm='argon2id-v1',credential_params_json=?,
           must_change_password=1,session_version=?,failed_login_count=0,locked_until=NULL,last_failed_login_at=NULL,
           credential_changed_at=?,updated_at=? WHERE id=?`,
    ).bind(body.salt, verifier, credentialParamsJson, nextSessionVersion, now, now, before.id),
    c.env.DB.prepare(`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE member_id=? AND revoked_at IS NULL`)
      .bind(now, before.id),
    c.env.DB.prepare(
      `INSERT INTO audit_events
       (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
       VALUES (?,?,'auth.credential_reset','member',?,NULL,?,?)`,
    ).bind(crypto.randomUUID(), actor.id, before.id, JSON.stringify({ mustChangePassword: true }), now),
    c.env.DB.prepare(
      `INSERT INTO idempotency_records
       (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
       VALUES (?,?,?,?,?,200,?)`,
    ).bind(idempotency, actor.id, operation, hash, JSON.stringify(response), now),
  ]);
  return c.json(response);
});

app.patch('/api/members/:id', requireRoles('admin'), async (c) => {
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

  const before = await findMemberById(c.env.DB, c.req.param('id'));
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
  if (protectsLastAdmin && await countEnabledAdmins(c.env.DB) <= 1) {
    return c.json(apiError('LAST_ADMIN_REQUIRED', '不能停用或降权最后一个启用管理员'), 422);
  }

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
  const condition = `EXISTS (SELECT 1 FROM members WHERE id = ? AND version = ? AND updated_at = ?)`;
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE members
       SET display_name=?,role=?,enabled=?,version=version+1,session_version=session_version+?,updated_at=?
       WHERE id=? AND version=?
         ${protectsLastAdmin ? "AND (SELECT COUNT(*) FROM members WHERE enabled=1 AND role='admin') > 1" : ''}`,
    ).bind(nextDisplayName, nextRole, nextEnabled ? 1 : 0, invalidateSessions ? 1 : 0, now, before.id, before.version),
    c.env.DB.prepare(`DELETE FROM member_scopes WHERE member_id=? AND ${condition}`)
      .bind(before.id, before.id, nextVersion, now),
    ...scopeStatements(c, before.id, nextScopes, nextVersion, now),
    c.env.DB.prepare(
      `INSERT INTO audit_events
       (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
       SELECT ?,?,'member.update','member',?,?,?,? WHERE ${condition}`,
    ).bind(
      crypto.randomUUID(), actor.id, before.id, JSON.stringify(before), JSON.stringify(nextData), now,
      before.id, nextVersion, now,
    ),
    c.env.DB.prepare(
      `INSERT INTO idempotency_records
       (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
       SELECT ?,?,?,?,?,200,? WHERE ${condition}`,
    ).bind(idempotency, actor.id, operation, hash, responseJson, now, before.id, nextVersion, now),
  ];
  if (invalidateSessions) {
    statements.push(c.env.DB.prepare(
      `UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE member_id=? AND revoked_at IS NULL AND ${condition}`,
    ).bind(now, before.id, before.id, nextVersion, now));
  }
  try {
    const results = await c.env.DB.batch(statements);
    if (Number(results[0]?.meta.changes ?? 0) !== 1) {
      if (protectsLastAdmin && await countEnabledAdmins(c.env.DB) <= 1) {
        return c.json(apiError('LAST_ADMIN_REQUIRED', '不能停用或降权最后一个启用管理员'), 422);
      }
      return c.json(apiError('VERSION_CONFLICT', '成员已被其他人修改，请刷新后重试'), 409);
    }
  } catch {
    return c.json(apiError('MEMBER_UPDATE_FAILED', '成员更新失败，请刷新后重试'), 409);
  }
  return c.json(response);
});

app.get('/api/settings', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true as const, data: { items: await listCurrentSettings(c.env.DB) } });
});

app.get('/api/settings/:key/history', requireRoles('admin'), async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true as const, data: { items: await getSettingHistory(c.env.DB, c.req.param('key')) } });
});

app.put('/api/settings/:key', requireRoles('admin'), async (c) => {
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
  const current = await c.env.DB.prepare(
    `SELECT version FROM settings_versions WHERE setting_key=? ORDER BY version DESC LIMIT 1`,
  ).bind(key).first<{ version: number }>();
  const currentVersion = current?.version ?? null;
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
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO settings_versions
         (id,setting_key,version,value_json,effective_from,created_by,created_at) VALUES (?,?,?,?,?,?,?)`,
      ).bind(id, key, nextVersion, valueJson, effectiveFrom, actor.id, now),
      c.env.DB.prepare(
        `INSERT INTO audit_events
         (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
         VALUES (?,?,'setting.version.create','setting',?,?,?,?)`,
      ).bind(crypto.randomUUID(), actor.id, key, JSON.stringify({ version: currentVersion }), JSON.stringify(data), now),
      c.env.DB.prepare(
        `INSERT INTO idempotency_records
         (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
         VALUES (?,?,?,?,?,200,?)`,
      ).bind(idempotency, actor.id, operation, hash, JSON.stringify(response), now),
    ]);
  } catch {
    return c.json(apiError('VERSION_CONFLICT', '配置已被并发修改，请刷新后重试'), 409);
  }
  return c.json(response);
});

app.get('/api/dictionaries', async (c) => {
  const key = c.req.query('key')?.trim();
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true as const, data: { items: await listDictionary(c.env.DB, key || undefined) } });
});

app.get('/api/scopes/:scopeType/:scopeId/check', async (c) => {
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

app.route('/api', p2App);
app.route('/api', p3App);
app.route('/api', p4App);
app.route('/api', p5App);

app.notFound((c) => c.json(apiError('NOT_FOUND', '接口不存在或尚未实现'), 404));
