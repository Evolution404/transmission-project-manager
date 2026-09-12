import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanupStateDir, makeStateDir, startWranglerServer } from './helpers/wrangler.mjs';

const testStateDir = makeStateDir('tpm-p1-1-test-');
let runtime;
let bootstrapResult;

function request(path, init = {}) {
  return runtime.request(path, init);
}

async function jsonRequest(path, init = {}) {
  const response = await request(path, init);
  return { response, body: await response.json() };
}

async function createMember(body) {
  return jsonRequest('/api/members', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `test-${crypto.randomUUID()}` },
    body: JSON.stringify(body),
  });
}

before(async () => {
  runtime = await startWranglerServer({ stateDir: testStateDir, port: 8799, seed: false, migrate: true });

  const bootstrap = await jsonRequest('/api/bootstrap/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dev-User-Email': 'dev-admin@example.invalid' },
    body: JSON.stringify({ displayName: '本地开发管理员' }),
  });
  if (bootstrap.response.status !== 201) {
    throw new Error(`Bootstrap failed: ${bootstrap.response.status} ${JSON.stringify(bootstrap.body)}\n${runtime.output()}`);
  }
  bootstrapResult = bootstrap.body;

  const readonly = await createMember({
    email: 'dev-readonly@example.invalid',
    displayName: '本地只读测试成员',
    role: 'readonly',
    enabled: true,
    scopes: [{ type: 'project', id: 'synthetic-project-a' }],
  });
  if (readonly.response.status !== 201) throw new Error(`Readonly seed failed: ${JSON.stringify(readonly.body)}`);

  const disabled = await createMember({
    email: 'dev-disabled@example.invalid',
    displayName: '本地停用测试成员',
    role: 'readonly',
    enabled: false,
    scopes: [],
  });
  if (disabled.response.status !== 201) throw new Error(`Disabled seed failed: ${JSON.stringify(disabled.body)}`);
}, { timeout: 80000 });

after(async () => {
  await runtime?.stop();
  cleanupStateDir(testStateDir);
});

test('built SPA is served by the local Workers asset binding', async () => {
  const response = await request('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await response.text(), /输电项目全流程管理台/);
});

test('API health reports P1.1 without claiming later business stages', async () => {
  const response = await request('/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, data: { service: 'transmission-project-manager', stage: 'p1.1' },
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('bootstrap creates exactly one explicit first administrator and then closes', async () => {
  assert.equal(bootstrapResult.data.email, 'dev-admin@example.invalid');
  assert.equal(bootstrapResult.data.role, 'admin');
  assert.equal(bootstrapResult.data.lifecycleStatus, 'active');
  assert.deepEqual(bootstrapResult.data.scopes, [{ type: 'all', id: null }]);

  const second = await jsonRequest('/api/bootstrap/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dev-User-Email': 'dev-admin@example.invalid' },
    body: JSON.stringify({ displayName: 'Another Admin' }),
  });
  assert.equal(second.response.status, 409);
  assert.equal(second.body.error.code, 'BOOTSTRAP_CLOSED');

  const wrongIdentity = await jsonRequest('/api/bootstrap/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dev-User-Email': 'other@example.invalid' },
    body: JSON.stringify({ displayName: 'Wrong User' }),
  });
  assert.equal(wrongIdentity.response.status, 403);
  assert.equal(wrongIdentity.body.error.code, 'BOOTSTRAP_FORBIDDEN');
});

test('development identity resolves from D1 and login lifecycle becomes active', async () => {
  const response = await request('/api/me', { headers: { 'X-Dev-User-Role': 'readonly' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.email, 'dev-admin@example.invalid');
  assert.equal(body.data.role, 'admin');
  assert.equal(body.data.authSource, 'development');
  assert.equal(body.data.lifecycleStatus, 'active');
  assert.ok(body.data.firstLoginAt);
  assert.ok(body.data.lastLoginAt);
});

test('new member lifecycle, duplicate protection, scope update and idempotent replay work', async () => {
  const email = `new-member-${Date.now()}@example.invalid`;
  const created = await createMember({
    email,
    displayName: '新成员',
    role: 'readonly',
    enabled: true,
    scopes: [{ type: 'project', id: 'synthetic-project-new' }],
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.lifecycleStatus, 'pending_first_login');
  assert.equal(created.body.data.firstLoginAt, null);
  assert.equal(created.body.data.version, 1);

  const duplicate = await createMember({
    email,
    displayName: '重复成员',
    role: 'readonly',
    enabled: true,
    scopes: [],
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error.code, 'MEMBER_EMAIL_EXISTS');

  const firstLogin = await jsonRequest('/api/me', { headers: { 'X-Dev-User-Email': email } });
  assert.equal(firstLogin.response.status, 200);
  assert.equal(firstLogin.body.data.lifecycleStatus, 'active');
  assert.ok(firstLogin.body.data.firstLoginAt);
  assert.ok(firstLogin.body.data.lastLoginAt);
  assert.equal(firstLogin.body.data.version, 1, 'login telemetry must not bump the business version');

  const updateBody = {
    expectedVersion: 1,
    role: 'project_manager',
    scopes: [{ type: 'framework', id: 'synthetic-framework-a' }],
  };
  const idempotencyKey = `test-${crypto.randomUUID()}`;
  const updated = await jsonRequest(`/api/members/${created.body.data.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(updateBody),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.data.version, 2);
  assert.equal(updated.body.data.role, 'project_manager');
  assert.deepEqual(updated.body.data.scopes, [{ type: 'framework', id: 'synthetic-framework-a' }]);

  const replay = await jsonRequest(`/api/members/${created.body.data.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(updateBody),
  });
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body, updated.body);

  const allowed = await request('/api/scopes/framework/synthetic-framework-a/check', {
    headers: { 'X-Dev-User-Email': email },
  });
  assert.equal(allowed.status, 200);

  const denied = await jsonRequest('/api/scopes/project/synthetic-project-new/check', {
    headers: { 'X-Dev-User-Email': email },
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error.code, 'SCOPE_FORBIDDEN');
});

test('last enabled administrator cannot be disabled or demoted', async () => {
  const members = await jsonRequest('/api/members');
  const admin = members.body.data.items.find((item) => item.email === 'dev-admin@example.invalid');
  assert.ok(admin);

  const disabled = await jsonRequest(`/api/members/${admin.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `test-${crypto.randomUUID()}` },
    body: JSON.stringify({ expectedVersion: admin.version, enabled: false }),
  });
  assert.equal(disabled.response.status, 422);
  assert.equal(disabled.body.error.code, 'LAST_ADMIN_REQUIRED');

  const demoted = await jsonRequest(`/api/members/${admin.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `test-${crypto.randomUUID()}` },
    body: JSON.stringify({ expectedVersion: admin.version, role: 'readonly', scopes: [] }),
  });
  assert.equal(demoted.response.status, 422);
  assert.equal(demoted.body.error.code, 'LAST_ADMIN_REQUIRED');
});

test('disabled members are rejected before business routes execute', async () => {
  const response = await request('/api/me', {
    headers: { 'X-Dev-User-Email': 'dev-disabled@example.invalid' },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'MEMBER_DISABLED');
});

test('readonly member cannot access or mutate member administration', async () => {
  const headers = { 'X-Dev-User-Email': 'dev-readonly@example.invalid' };
  const list = await jsonRequest('/api/members', { headers });
  assert.equal(list.response.status, 403);
  assert.equal(list.body.error.code, 'FORBIDDEN');

  const create = await jsonRequest('/api/members', {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Idempotency-Key': `test-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({
      email: 'unauthorized@example.invalid', displayName: 'Unauthorized', role: 'readonly', scopes: [],
    }),
  });
  assert.equal(create.response.status, 403);
  assert.equal(create.body.error.code, 'FORBIDDEN');
});

test('scope checks allow the assigned project and reject cross-project access', async () => {
  const headers = { 'X-Dev-User-Email': 'dev-readonly@example.invalid' };
  const allowed = await request('/api/scopes/project/synthetic-project-a/check', { headers });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).data.allowed, true);

  const denied = await jsonRequest('/api/scopes/project/synthetic-project-b/check', { headers });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error.code, 'SCOPE_FORBIDDEN');
});

test('settings are versioned and mutation requests are idempotent', async () => {
  const key = `test.setting.${process.pid}.${Date.now()}`;
  const body = { expectedVersion: null, value: { threshold: 80 } };
  const headers = {
    'Content-Type': 'application/json',
    'Idempotency-Key': `test-${crypto.randomUUID()}`,
  };

  const created = await jsonRequest(`/api/settings/${key}`, {
    method: 'PUT', headers, body: JSON.stringify(body),
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.data.version, 1);

  const replay = await jsonRequest(`/api/settings/${key}`, {
    method: 'PUT', headers, body: JSON.stringify(body),
  });
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body, created.body);

  const keyConflict = await jsonRequest(`/api/settings/${key}`, {
    method: 'PUT', headers, body: JSON.stringify({ ...body, value: { threshold: 81 } }),
  });
  assert.equal(keyConflict.response.status, 409);
  assert.equal(keyConflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

  const stale = await jsonRequest(`/api/settings/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `test-${crypto.randomUUID()}` },
    body: JSON.stringify(body),
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');

  const updated = await jsonRequest(`/api/settings/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `test-${crypto.randomUUID()}` },
    body: JSON.stringify({ expectedVersion: 1, value: { threshold: 82 } }),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.data.version, 2);

  const history = await jsonRequest(`/api/settings/${key}/history`);
  assert.equal(history.response.status, 200);
  assert.equal(history.body.data.items.length, 2);
  assert.deepEqual(history.body.data.items.map((item) => item.version), [2, 1]);
});

test('dictionary endpoint returns the seeded member roles', async () => {
  const response = await jsonRequest('/api/dictionaries?key=member_role');
  assert.equal(response.response.status, 200);
  assert.deepEqual(response.body.data.items.map((item) => item.itemKey), [
    'admin', 'project_manager', 'implementation', 'finance', 'readonly',
  ]);
});

test('unknown API routes return JSON 404 instead of the SPA HTML fallback', async () => {
  for (const pathname of ['/api', '/api/not-implemented']) {
    const response = await request(pathname, { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' } });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  }
});
