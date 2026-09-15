import { Hono } from 'hono';
import type { ChangePasswordRequest } from '@tpm/shared';
import type { AppEnv } from './auth.ts';
import { authRepositories, currentUserData, requireCredentialPepper } from './authentication-context.ts';
import { constantTimeEqualText, credentialParamsJson, credentialVerifier, validateCredentialValue, validateDerivedCredential } from './credential.ts';
import { apiError } from './http/request-values.ts';
import { clearSessionCookie, createSession, getSessionToken, revokeSessionToken } from './session.ts';

export const accountApp = new Hono<AppEnv>();

accountApp.get('/me', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true as const, data: c.get('currentUser') });
});

accountApp.post('/auth/logout', async (c) => {
  const token = getSessionToken(c);
  if (token) await revokeSessionToken(c, token);
  clearSessionCookie(c);
  return c.json({ ok: true as const, data: { loggedOut: true } });
});

accountApp.post('/auth/change-password', async (c) => {
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
  const { credentials, members } = authRepositories(c);
  const record = await credentials.findByMemberId(user.id);
  if (!record) return c.json(apiError('MEMBER_NOT_FOUND', '成员不存在'), 404);
  const currentVerifier = await credentialVerifier(body.currentCredential, pepper);
  if (!constantTimeEqualText(currentVerifier, record.credentialVerifier)) {
    return c.json(apiError('INVALID_CURRENT_PASSWORD', '当前密码错误'), 401);
  }

  const nextVerifier = await credentialVerifier(body.next.credential, pepper);
  const now = new Date().toISOString();
  const nextSessionVersion = record.sessionVersion + 1;
  await credentials.changeOwnCredential({
    memberId: user.id,
    salt: body.next.salt,
    verifier: nextVerifier,
    paramsJson: credentialParamsJson,
    nextSessionVersion,
    nowIso: now,
    auditEventId: crypto.randomUUID(),
  });
  await createSession(c, user.id, nextSessionVersion);
  const refreshed = await members.findById(user.id);
  if (!refreshed) return c.json(apiError('MEMBER_NOT_FOUND', '成员不存在'), 404);
  return c.json({ ok: true as const, data: currentUserData(refreshed) });
});
