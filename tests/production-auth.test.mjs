import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanupStateDir, makeStateDir, startWranglerServer } from './helpers/wrangler.mjs';

const stateDir = makeStateDir('tpm-production-auth-');
let runtime;

before(async () => {
  runtime = await startWranglerServer({
    stateDir,
    port: 8800,
    vars: ['APP_ENV:production'],
    seed: true,
    migrate: true,
  });
}, { timeout: 80000 });

after(async () => {
  await runtime?.stop();
  cleanupStateDir(stateDir);
});

test('health stays public in production mode', async () => {
  const response = await runtime.request('/api/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.stage, 'p1.1');
});

test('production ignores development identity headers and fails closed without Access configuration', async () => {
  const response = await runtime.request('/api/me', {
    headers: { 'X-Dev-User-Email': 'dev-admin@example.invalid' },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'AUTH_CONFIG_MISSING');
});

test('bootstrap also fails closed in production without Access configuration', async () => {
  const response = await runtime.request('/api/bootstrap/admin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `prod-${crypto.randomUUID()}`,
      'X-Dev-User-Email': 'dev-admin@example.invalid',
    },
    body: JSON.stringify({ displayName: '不应创建' }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'AUTH_CONFIG_MISSING');
});
