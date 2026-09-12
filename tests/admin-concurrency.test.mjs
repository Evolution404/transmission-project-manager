import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  cleanupStateDir,
  makeStateDir,
  queryLocalD1,
  startWranglerServer,
} from './helpers/wrangler.mjs';

const stateDir = makeStateDir('tpm-admin-race-');
let runtime;
let firstAdmin;
let secondAdmin;

async function jsonRequest(path, init = {}) {
  const response = await runtime.request(path, init);
  return { response, body: await response.json() };
}

before(async () => {
  runtime = await startWranglerServer({ stateDir, port: 8801, seed: false, migrate: true });

  const bootstrap = await jsonRequest('/api/bootstrap/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dev-User-Email': 'dev-admin@example.invalid' },
    body: JSON.stringify({ displayName: '并发管理员 A' }),
  });
  assert.equal(bootstrap.response.status, 201);
  firstAdmin = bootstrap.body.data;

  const create = await jsonRequest('/api/members', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `race-create-${crypto.randomUUID()}`,
      'X-Dev-User-Email': 'dev-admin@example.invalid',
    },
    body: JSON.stringify({
      email: 'admin-b@example.invalid', displayName: '并发管理员 B', role: 'admin', enabled: true,
      scopes: [{ type: 'all', id: null }],
    }),
  });
  assert.equal(create.response.status, 201);
  secondAdmin = create.body.data;
}, { timeout: 80000 });

after(async () => {
  await runtime?.stop();
  cleanupStateDir(stateDir);
});

test('concurrent demotions can never leave the system with zero enabled administrators', async () => {
  const [demoteA, demoteB] = await Promise.all([
    jsonRequest(`/api/members/${firstAdmin.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `race-a-${crypto.randomUUID()}`,
        'X-Dev-User-Email': 'admin-b@example.invalid',
      },
      body: JSON.stringify({ expectedVersion: firstAdmin.version, role: 'readonly', scopes: [] }),
    }),
    jsonRequest(`/api/members/${secondAdmin.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `race-b-${crypto.randomUUID()}`,
        'X-Dev-User-Email': 'dev-admin@example.invalid',
      },
      body: JSON.stringify({ expectedVersion: secondAdmin.version, role: 'readonly', scopes: [] }),
    }),
  ]);

  const successCount = [demoteA, demoteB].filter((item) => item.response.status === 200).length;
  const rows = queryLocalD1(stateDir, "SELECT COUNT(*) AS count FROM members WHERE enabled=1 AND role='admin';")
    .flatMap((entry) => entry.results ?? []);

  assert.equal(rows[0].count, 1, `并发结果不得把管理员归零；HTTP=${demoteA.response.status}/${demoteB.response.status}`);
  assert.equal(successCount, 1, '两个并发降权请求必须恰好一个成功');
});
