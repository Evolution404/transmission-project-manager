import assert from 'node:assert/strict';

export function b64(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

export function fixedCredential(byte) {
  return b64(Buffer.alloc(32, byte));
}

export function fixedSalt(byte) {
  return b64(Buffer.alloc(16, byte));
}

export function cookiePair(setCookie) {
  assert.ok(setCookie, 'response must set a session cookie');
  return setCookie.split(';', 1)[0];
}

export function mutation(method, body, headers = {}) {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

export async function jsonRequest(runtime, path, init = {}) {
  const response = await runtime.request(path, init);
  let body = null;
  try { body = await response.json(); } catch { /* no JSON body */ }
  return { response, body };
}

export async function bootstrapAdmin(runtime, {
  token = 'test-bootstrap-token',
  username = 'admin',
  displayName = '系统管理员',
  salt = fixedSalt(1),
  credential = fixedCredential(1),
} = {}) {
  const result = await jsonRequest(runtime, '/api/auth/bootstrap', mutation('POST', {
    username, displayName, salt, credential,
  }, { 'X-Bootstrap-Token': token }));
  return result;
}

export async function loginWithCredential(runtime, username, credential) {
  return jsonRequest(runtime, '/api/auth/login', mutation('POST', { username, credential }));
}

export async function createMember(runtime, cookie, {
  username,
  displayName = username,
  salt = fixedSalt(2),
  credential = fixedCredential(2),
  role = 'readonly',
  enabled = true,
  scopes = [],
  idempotencyKey = `member-${crypto.randomUUID()}`,
}) {
  return jsonRequest(runtime, '/api/members', mutation('POST', {
    username, displayName, salt, credential, role, enabled, scopes,
  }, { Cookie: cookie, 'Idempotency-Key': idempotencyKey }));
}
