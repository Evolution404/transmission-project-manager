import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { app } from '../apps/api/src/app.ts';

const maintenanceEnv = {
  APP_ENV: 'production',
  MAINTENANCE_MODE: 'data-migration',
};

test('data migration maintenance health is available without touching persistence', async () => {
  const response = await app.request('/api/health', {}, maintenanceEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    data: {
      service: 'transmission-project-manager',
      maintenance: { active: true, reason: 'data-migration' },
    },
  });
});

test('data migration maintenance blocks every other API route before authentication or database access', async () => {
  for (const path of ['/api/auth/status', '/api/auth/login', '/api/settings', '/api/system/tasks/run']) {
    const response = await app.request(path, { method: path.endsWith('/login') || path.endsWith('/run') ? 'POST' : 'GET' }, maintenanceEnv);
    assert.equal(response.status, 503, path);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'MAINTENANCE');
  }
});

test('scheduled operations are disabled before persistence is resolved during data migration maintenance', () => {
  const source = readFileSync(new URL('../apps/api/src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(env\.MAINTENANCE_MODE === 'data-migration'\) return;/);
  assert.ok(source.indexOf("if (env.MAINTENANCE_MODE === 'data-migration') return;") < source.indexOf('runScheduledOperations(runtimeBindings(env)'));
});
