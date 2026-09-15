import { Hono } from 'hono';
import type { BootstrapAdminRequest, LoginKdfRequest, LoginRequest } from '@tpm/shared';
import type { AppEnv } from './auth.ts';
import { authRepositories, currentUserData, requireCredentialPepper } from './authentication-context.ts';
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
} from './credential.ts';
import { apiError } from './http/request-values.ts';
import { createSession } from './session.ts';

const LOCK_AFTER_FAILURES = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

export const publicAuthenticationApp = new Hono<AppEnv>();

publicAuthenticationApp.get('/auth/status', async (c) => {
  c.header('Cache-Control', 'no-store');
  const { members } = authRepositories(c);
  return c.json({ ok: true as const, data: { initialized: (await members.count()) > 0 } });
});

publicAuthenticationApp.post('/auth/kdf', async (c) => {
  const pepper = requireCredentialPepper(c);
  if (pepper instanceof Response) return pepper;
  let body: LoginKdfRequest;
  try { body = await c.req.json<LoginKdfRequest>(); } catch {
    return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400);
  }
  const username = normalizeUsername(body.username);
  const { credentials } = authRepositories(c);
  const credential = username ? await credentials.findByUsername(username) : null;
  const salt = credential?.credentialSalt ?? await fakeSaltForUsername(username ?? 'invalid-user', pepper);
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true as const, data: credentialDescriptor(salt) });
});

publicAuthenticationApp.post('/auth/bootstrap', async (c) => {
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
  const { memberAdmin, members } = authRepositories(c);
  if (await members.count() > 0) return c.json(apiError('BOOTSTRAP_CLOSED', '系统已有账号，首管理员初始化已关闭'), 409);

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
    const created = await memberAdmin.bootstrapAdmin({
      memberId,
      username,
      displayName,
      salt: body.salt,
      verifier,
      credentialParamsJson,
      nowIso: now,
      scopeId: crypto.randomUUID(),
      auditEventId: crypto.randomUUID(),
      auditAfterJson: JSON.stringify(data),
    });
    if (!created) return c.json(apiError('BOOTSTRAP_CLOSED', '首管理员已被其他请求初始化'), 409);
  } catch {
    return c.json(apiError('BOOTSTRAP_CLOSED', '首管理员初始化失败或已经完成'), 409);
  }

  await createSession(c, memberId, 1);
  return c.json({ ok: true as const, data: currentUserData(data) }, 201);
});

publicAuthenticationApp.post('/auth/login', async (c) => {
  const pepper = requireCredentialPepper(c);
  if (pepper instanceof Response) return pepper;
  let body: LoginRequest;
  try { body = await c.req.json<LoginRequest>(); } catch {
    return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400);
  }
  const username = normalizeUsername(body.username);
  const generic = () => c.json(apiError('INVALID_CREDENTIALS', '账号或密码错误'), 401);
  if (!username || !validateCredentialValue(body.credential)) return generic();

  const { credentials, members } = authRepositories(c);
  const record = await credentials.findByUsername(username);
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
    await credentials.recordLoginFailure({
      memberId: record.memberId,
      failedLoginCount: failures,
      lockedUntil,
      nowIso,
      auditEventId: crypto.randomUUID(),
    });
    return generic();
  }

  const member = await members.findById(record.memberId);
  if (!member) return generic();
  if (!member.enabled) return c.json(apiError('MEMBER_DISABLED', '当前账号已停用'), 403);

  await credentials.clearLoginFailures(member.id, nowIso);
  const staleBefore = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const activeMember = await members.recordSuccessfulLogin(member, nowIso, staleBefore);
  await createSession(c, member.id, record.sessionVersion);
  return c.json({ ok: true as const, data: currentUserData(activeMember) });
});
