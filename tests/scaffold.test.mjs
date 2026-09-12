import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanupStateDir, executeLocalD1, makeStateDir, startWranglerServer } from './helpers/wrangler.mjs';
import {
  bootstrapAdmin,
  cookiePair,
  createMember,
  fixedCredential,
  fixedSalt,
  jsonRequest,
  loginWithCredential,
  mutation,
} from './helpers/auth.mjs';

const stateDir = makeStateDir('tpm-scaffold-');
let runtime;
let adminCookie;
let readonlyCookie;

before(async () => {
  runtime = await startWranglerServer({
    stateDir,
    port: 8799,
    migrate: true,
    vars: ['AUTH_CREDENTIAL_PEPPER:scaffold-pepper', 'BOOTSTRAP_TOKEN:scaffold-bootstrap'],
  });
  const bootstrap = await bootstrapAdmin(runtime, { token: 'scaffold-bootstrap' });
  assert.equal(bootstrap.response.status, 201);
  adminCookie = cookiePair(bootstrap.response.headers.get('set-cookie'));

  const created = await createMember(runtime, adminCookie, {
    username: 'readonly-user', displayName: '只读测试成员',
    salt: fixedSalt(8), credential: fixedCredential(8),
    scopes: [{ type: 'project', id: 'synthetic-project-a' }],
  });
  assert.equal(created.response.status, 201);
  executeLocalD1(stateDir, { command: "UPDATE members SET must_change_password=0 WHERE username='readonly-user'" });
  const login = await loginWithCredential(runtime, 'readonly-user', fixedCredential(8));
  assert.equal(login.response.status, 200);
  readonlyCookie = cookiePair(login.response.headers.get('set-cookie'));
}, { timeout: 80000 });

after(async () => {
  await runtime?.stop();
  cleanupStateDir(stateDir);
});

test('built SPA is served by the local Workers asset binding', async () => {
  const response = await runtime.request('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await response.text(), /输电项目全流程管理台/);
});

test('API health reports P4 after framework and finance management are completed', async () => {
  const response = await runtime.request('/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, data: { service: 'transmission-project-manager', stage: 'p4' },
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('readonly member is blocked from member administration and constrained by scope', async () => {
  const list = await jsonRequest(runtime, '/api/members', { headers: { Cookie: readonlyCookie } });
  assert.equal(list.response.status, 403);
  assert.equal(list.body.error.code, 'FORBIDDEN');

  const allowed = await jsonRequest(runtime, '/api/scopes/project/synthetic-project-a/check', { headers: { Cookie: readonlyCookie } });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.body.data.allowed, true);

  const denied = await jsonRequest(runtime, '/api/scopes/project/synthetic-project-b/check', { headers: { Cookie: readonlyCookie } });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error.code, 'SCOPE_FORBIDDEN');
});

test('settings are versioned and mutation requests are idempotent', async () => {
  const key = `test.setting.${process.pid}.${Date.now()}`;
  const body = { expectedVersion: null, value: { threshold: 80 } };
  const idem = `setting-${crypto.randomUUID()}`;
  const headers = { Cookie: adminCookie, 'Idempotency-Key': idem };

  const created = await jsonRequest(runtime, `/api/settings/${key}`, mutation('PUT', body, headers));
  assert.equal(created.response.status, 200);
  assert.equal(created.body.data.version, 1);

  const replay = await jsonRequest(runtime, `/api/settings/${key}`, mutation('PUT', body, headers));
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body, created.body);

  const conflict = await jsonRequest(runtime, `/api/settings/${key}`, mutation('PUT', {
    ...body, value: { threshold: 81 },
  }, headers));
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

  const updated = await jsonRequest(runtime, `/api/settings/${key}`, mutation('PUT', {
    expectedVersion: 1, value: { threshold: 82 },
  }, { Cookie: adminCookie, 'Idempotency-Key': `setting-${crypto.randomUUID()}` }));
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.data.version, 2);

  const history = await jsonRequest(runtime, `/api/settings/${key}/history`, { headers: { Cookie: adminCookie } });
  assert.deepEqual(history.body.data.items.map((item) => item.version), [2, 1]);
});

test('dictionary endpoint returns the seeded role definitions', async () => {
  const response = await jsonRequest(runtime, '/api/dictionaries?key=member_role', { headers: { Cookie: adminCookie } });
  assert.equal(response.response.status, 200);
  assert.deepEqual(response.body.data.items.map((item) => item.itemKey), [
    'admin', 'project_manager', 'implementation', 'finance', 'readonly',
  ]);
});

test('authenticated unknown API routes return JSON 404 instead of the SPA HTML fallback', async () => {
  for (const pathname of ['/api', '/api/not-implemented']) {
    const response = await runtime.request(pathname, {
      headers: { Cookie: adminCookie, Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' },
    });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  }
});
