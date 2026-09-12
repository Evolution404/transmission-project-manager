import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  cleanupStateDir,
  makeStateDir,
  queryLocalD1,
  startWranglerServer,
} from './helpers/wrangler.mjs';

const stateDir = makeStateDir('tpm-member-atomicity-');
let runtime;
let member;
let successfulKey;

async function jsonRequest(path, init = {}) {
  const response = await runtime.request(path, init);
  return { response, body: await response.json() };
}

function rows(sql) {
  return queryLocalD1(stateDir, sql).flatMap((entry) => entry.results ?? []);
}

before(async () => {
  runtime = await startWranglerServer({ stateDir, port: 8802, seed: false, migrate: true });

  const bootstrap = await jsonRequest('/api/bootstrap/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dev-User-Email': 'dev-admin@example.invalid' },
    body: JSON.stringify({ displayName: '原子性管理员' }),
  });
  assert.equal(bootstrap.response.status, 201);

  const created = await jsonRequest('/api/members', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `atomic-create-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({
      email: 'atomic-member@example.invalid', displayName: '原子性成员', role: 'readonly', enabled: true,
      scopes: [{ type: 'project', id: 'project-old' }],
    }),
  });
  assert.equal(created.response.status, 201);
  member = created.body.data;

  successfulKey = `atomic-update-${crypto.randomUUID()}`;
  const updated = await jsonRequest(`/api/members/${member.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': successfulKey },
    body: JSON.stringify({
      expectedVersion: 1,
      role: 'project_manager',
      scopes: [{ type: 'framework', id: 'framework-new' }],
    }),
  });
  assert.equal(updated.response.status, 200);
}, { timeout: 80000 });

after(async () => {
  await runtime?.stop();
  cleanupStateDir(stateDir);
});

test('a stale member update cannot leave orphan scopes, audit rows or idempotency rows', async () => {
  const auditBefore = rows(`SELECT COUNT(*) AS count FROM audit_events WHERE object_type='member' AND object_id='${member.id}' AND action='member.update';`)[0].count;
  const idemBefore = rows(`SELECT COUNT(*) AS count FROM idempotency_records WHERE operation='members.patch:${member.id}';`)[0].count;
  const staleKey = `atomic-stale-${crypto.randomUUID()}`;

  const stale = await jsonRequest(`/api/members/${member.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': staleKey },
    body: JSON.stringify({
      expectedVersion: 1,
      role: 'finance',
      scopes: [{ type: 'project', id: 'project-should-not-exist' }],
    }),
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');

  const current = rows(`SELECT role,version FROM members WHERE id='${member.id}';`)[0];
  assert.deepEqual(current, { role: 'project_manager', version: 2 });
  assert.deepEqual(rows(`SELECT scope_type,scope_id FROM member_scopes WHERE member_id='${member.id}' ORDER BY scope_type,scope_id;`), [
    { scope_type: 'framework', scope_id: 'framework-new' },
  ]);
  assert.equal(rows(`SELECT COUNT(*) AS count FROM audit_events WHERE object_type='member' AND object_id='${member.id}' AND action='member.update';`)[0].count, auditBefore);
  assert.equal(rows(`SELECT COUNT(*) AS count FROM idempotency_records WHERE operation='members.patch:${member.id}';`)[0].count, idemBefore);
  assert.equal(rows(`SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='${staleKey}';`)[0].count, 0);
});

test('idempotent replay returns the stored response without duplicating audit history', async () => {
  const auditBefore = rows(`SELECT COUNT(*) AS count FROM audit_events WHERE object_type='member' AND object_id='${member.id}' AND action='member.update';`)[0].count;
  const idemBefore = rows(`SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='${successfulKey}';`)[0].count;

  const replay = await jsonRequest(`/api/members/${member.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': successfulKey },
    body: JSON.stringify({
      expectedVersion: 1,
      role: 'project_manager',
      scopes: [{ type: 'framework', id: 'framework-new' }],
    }),
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.data.version, 2);

  assert.equal(rows(`SELECT COUNT(*) AS count FROM audit_events WHERE object_type='member' AND object_id='${member.id}' AND action='member.update';`)[0].count, auditBefore);
  assert.equal(rows(`SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='${successfulKey}';`)[0].count, idemBefore);
});
