import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const wranglerPackage = require('wrangler/package.json');
const wranglerCli = resolve(dirname(require.resolve('wrangler/package.json')), wranglerPackage.bin.wrangler);
const apiDir = fileURLToPath(new URL('../apps/api/', import.meta.url));
const origin = 'http://127.0.0.1:8799';
const testStateDir = mkdtempSync(join(tmpdir(), 'tpm-p1-test-'));
let server;
let exited;
let output = '';

function request(path, init = {}) {
  return fetch(`${origin}${path}`, init);
}

before(async () => {
  const migration = spawnSync(
    process.execPath,
    [wranglerCli, 'd1', 'migrations', 'apply', 'transmission-project-manager-local', '--local', '--persist-to', testStateDir],
    {
      cwd: apiDir,
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
      encoding: 'utf8',
      timeout: 60000,
    },
  );
  if (migration.status !== 0) {
    throw new Error(`D1 migration failed:\n${migration.stdout}\n${migration.stderr}`);
  }

  const seed = spawnSync(
    process.execPath,
    [wranglerCli, 'd1', 'execute', 'transmission-project-manager-local', '--local', '--persist-to', testStateDir, '--file', 'seeds/local.sql'],
    {
      cwd: apiDir,
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
      encoding: 'utf8',
      timeout: 60000,
    },
  );
  if (seed.status !== 0) {
    throw new Error(`D1 local seed failed:\n${seed.stdout}\n${seed.stderr}`);
  }

  server = spawn(process.execPath, [wranglerCli, 'dev', '--local', '--persist-to', testStateDir, '--ip', '127.0.0.1', '--port', '8799'], {
    cwd: apiDir,
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  exited = new Promise((resolveExit) => server.once('exit', resolveExit));
  server.stdout.on('data', (chunk) => { output = (output + chunk).slice(-16000); });
  server.stderr.on('data', (chunk) => { output = (output + chunk).slice(-16000); });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error(`Wrangler exited:\n${output}`);
    try {
      const response = await request('/api/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Wait for the local runtime to start. */ }
    await delay(500);
  }
  throw new Error(`Wrangler failed to start:\n${output}`);
}, { timeout: 80000 });

after(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([exited, delay(5000)]);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  }
  rmSync(testStateDir, { recursive: true, force: true });
});

test('built SPA is served by the local Workers asset binding', async () => {
  const response = await request('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await response.text(), /输电项目全流程管理台/);
});

test('API health reports P1 without claiming later business stages', async () => {
  const response = await request('/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, data: { service: 'transmission-project-manager', stage: 'p1' },
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('development identity resolves from D1 and never accepts a client-supplied role', async () => {
  const response = await request('/api/me', { headers: { 'X-Dev-User-Role': 'readonly' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.email, 'dev-admin@example.invalid');
  assert.equal(body.data.role, 'admin');
  assert.equal(body.data.authSource, 'development');
});

test('disabled members are rejected before business routes execute', async () => {
  const response = await request('/api/me', {
    headers: { 'X-Dev-User-Email': 'dev-disabled@example.invalid' },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'MEMBER_DISABLED');
});

test('role checks reject a readonly member from the member administration endpoint', async () => {
  const response = await request('/api/members', {
    headers: { 'X-Dev-User-Email': 'dev-readonly@example.invalid' },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'FORBIDDEN');
});

test('scope checks allow the assigned project and reject cross-project access', async () => {
  const headers = { 'X-Dev-User-Email': 'dev-readonly@example.invalid' };
  const allowed = await request('/api/scopes/project/synthetic-project-a/check', { headers });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).data.allowed, true);

  const denied = await request('/api/scopes/project/synthetic-project-b/check', { headers });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'SCOPE_FORBIDDEN');
});

test('settings are versioned and mutation requests are idempotent', async () => {
  const key = `test.setting.${process.pid}.${Date.now()}`;
  const body = { expectedVersion: null, value: { threshold: 80 } };
  const headers = {
    'Content-Type': 'application/json',
    'Idempotency-Key': `test-${crypto.randomUUID()}`,
  };

  const created = await request(`/api/settings/${key}`, {
    method: 'PUT', headers, body: JSON.stringify(body),
  });
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  assert.equal(createdBody.data.version, 1);

  const replay = await request(`/api/settings/${key}`, {
    method: 'PUT', headers, body: JSON.stringify(body),
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), createdBody);

  const keyConflict = await request(`/api/settings/${key}`, {
    method: 'PUT', headers, body: JSON.stringify({ ...body, value: { threshold: 81 } }),
  });
  assert.equal(keyConflict.status, 409);
  assert.equal((await keyConflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');

  const stale = await request(`/api/settings/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `test-${crypto.randomUUID()}` },
    body: JSON.stringify(body),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'VERSION_CONFLICT');

  const updated = await request(`/api/settings/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `test-${crypto.randomUUID()}` },
    body: JSON.stringify({ expectedVersion: 1, value: { threshold: 82 } }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).data.version, 2);

  const history = await request(`/api/settings/${key}/history`);
  assert.equal(history.status, 200);
  const items = (await history.json()).data.items;
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.version), [2, 1]);
});

test('dictionary endpoint returns the seeded member roles', async () => {
  const response = await request('/api/dictionaries?key=member_role');
  assert.equal(response.status, 200);
  const items = (await response.json()).data.items;
  assert.deepEqual(items.map((item) => item.itemKey), [
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
