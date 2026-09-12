import { Hono, type Context } from 'hono';
import {
  MEMBER_ROLES,
  type ApiError,
  type HealthResponse,
  type MemberRole,
  type UpdateMemberRequest,
  type UpdateSettingRequest,
} from '@tpm/shared';
import { hasScope, requireAuthentication, requireRoles, type AppEnv } from './auth';
import { getSettingHistory, listCurrentSettings, listDictionary, listMembers } from './db';

export const app = new Hono<AppEnv>();

const jsonHeaders = { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' };

function apiError(code: string, message: string, details?: unknown): ApiError {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === 'string' && MEMBER_ROLES.includes(value as MemberRole);
}

async function requestHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function replayIdempotentResponse(
  c: Context<AppEnv>,
  key: string,
  operation: string,
  hash: string,
) {
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

app.get('/api/health', (c) => {
  const body: HealthResponse = {
    ok: true,
    data: { service: 'transmission-project-manager', stage: 'p1' },
  };
  c.header('Cache-Control', 'no-store');
  return c.json(body);
});

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health') return next();
  return requireAuthentication(c, next);
});

app.get('/api/me', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true as const, data: c.get('currentUser') });
});

app.get('/api/members', requireRoles('admin'), async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true as const, data: { items: await listMembers(c.env.DB) } });
});

app.patch('/api/members/:id', requireRoles('admin'), async (c) => {
  const idempotency = requireIdempotencyKey(c);
  if (idempotency instanceof Response) return idempotency;

  let body: UpdateMemberRequest;
  try {
    body = await c.req.json<UpdateMemberRequest>();
  } catch {
    return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400);
  }
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) {
    return c.json(apiError('INVALID_VERSION', 'expectedVersion 必须是正整数'), 400);
  }
  if (body.role !== undefined && !isMemberRole(body.role)) {
    return c.json(apiError('INVALID_ROLE', '成员角色无效'), 422);
  }
  if (body.displayName !== undefined && (!body.displayName.trim() || body.displayName.trim().length > 80)) {
    return c.json(apiError('INVALID_DISPLAY_NAME', '成员名称不能为空且最多 80 个字符'), 422);
  }

  const hash = await requestHash(body);
  const replay = await replayIdempotentResponse(c, idempotency, `members.patch:${c.req.param('id')}`, hash);
  if (replay) return replay;

  const before = await c.env.DB.prepare(
    `SELECT id, email, display_name, role, enabled, version FROM members WHERE id = ? LIMIT 1`,
  ).bind(c.req.param('id')).first<{
    id: string; email: string; display_name: string; role: MemberRole; enabled: number; version: number;
  }>();
  if (!before) return c.json(apiError('MEMBER_NOT_FOUND', '成员不存在'), 404);
  if (before.version !== body.expectedVersion) {
    return c.json(apiError('VERSION_CONFLICT', '成员已被其他人修改，请刷新后重试', { currentVersion: before.version }), 409);
  }

  const nextDisplayName = body.displayName?.trim() ?? before.display_name;
  const nextRole = body.role ?? before.role;
  const nextEnabled = body.enabled === undefined ? before.enabled : body.enabled ? 1 : 0;
  const updatedAt = new Date().toISOString();
  const update = await c.env.DB.prepare(
    `UPDATE members
     SET display_name = ?, role = ?, enabled = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ?`,
  ).bind(nextDisplayName, nextRole, nextEnabled, updatedAt, before.id, body.expectedVersion).run();
  if (update.meta.changes !== 1) {
    return c.json(apiError('VERSION_CONFLICT', '成员已被其他人修改，请刷新后重试'), 409);
  }

  const actor = c.get('currentUser');
  const data = {
    id: before.id,
    email: before.email,
    displayName: nextDisplayName,
    role: nextRole,
    enabled: nextEnabled === 1,
    version: before.version + 1,
  };
  const response = { ok: true as const, data };
  const responseJson = JSON.stringify(response);
  const afterJson = JSON.stringify(data);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO audit_events (id, actor_member_id, action, object_type, object_id, before_json, after_json, created_at)
       VALUES (?, ?, 'member.update', 'member', ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), actor.id, before.id, JSON.stringify(before), afterJson, updatedAt),
    c.env.DB.prepare(
      `INSERT INTO idempotency_records
       (idempotency_key, actor_member_id, operation, request_hash, response_json, status_code, created_at)
       VALUES (?, ?, ?, ?, ?, 200, ?)`,
    ).bind(idempotency, actor.id, `members.patch:${before.id}`, hash, responseJson, updatedAt),
  ]);
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
  try {
    body = await c.req.json<UpdateSettingRequest>();
  } catch {
    return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400);
  }
  if (body.expectedVersion !== null && (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1)) {
    return c.json(apiError('INVALID_VERSION', 'expectedVersion 必须为 null 或正整数'), 400);
  }
  const key = c.req.param('key').trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(key)) {
    return c.json(apiError('INVALID_SETTING_KEY', '配置键格式无效'), 422);
  }

  let valueJson: string;
  try {
    valueJson = JSON.stringify(body.value);
  } catch {
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
    `SELECT version FROM settings_versions WHERE setting_key = ? ORDER BY version DESC LIMIT 1`,
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
  if (Number.isNaN(Date.parse(effectiveFrom))) {
    return c.json(apiError('INVALID_EFFECTIVE_FROM', 'effectiveFrom 必须是有效时间'), 422);
  }
  const data = {
    id,
    key,
    version: nextVersion,
    value: body.value,
    effectiveFrom,
    createdBy: actor.id,
    createdAt: now,
  };
  const response = { ok: true as const, data };
  const responseJson = JSON.stringify(response);

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO settings_versions
         (id, setting_key, version, value_json, effective_from, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, key, nextVersion, valueJson, effectiveFrom, actor.id, now),
      c.env.DB.prepare(
        `INSERT INTO audit_events
         (id, actor_member_id, action, object_type, object_id, before_json, after_json, created_at)
         VALUES (?, ?, 'setting.version.create', 'setting', ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), actor.id, key, JSON.stringify({ version: currentVersion }), JSON.stringify(data), now),
      c.env.DB.prepare(
        `INSERT INTO idempotency_records
         (idempotency_key, actor_member_id, operation, request_hash, response_json, status_code, created_at)
         VALUES (?, ?, ?, ?, ?, 200, ?)`,
      ).bind(idempotency, actor.id, operation, hash, responseJson, now),
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

app.notFound((c) => c.json(apiError('NOT_FOUND', '接口不存在或尚未实现'), 404));
