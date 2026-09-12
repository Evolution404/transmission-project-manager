import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanupStateDir, makeStateDir, queryLocalD1, startWranglerServer } from './helpers/wrangler.mjs';
import { bootstrapAdmin, cookiePair, createMember, jsonRequest, mutation } from './helpers/auth.mjs';

const stateDir = makeStateDir('tpm-member-atomicity-');
let runtime;
let adminCookie;
let member;
let successfulKey;

function rows(sql) {
  return queryLocalD1(stateDir, sql).flatMap((entry) => entry.results ?? []);
}

before(async () => {
  runtime = await startWranglerServer({
    stateDir, port: 8802, migrate: true,
    vars: ['AUTH_CREDENTIAL_PEPPER:atomicity-pepper', 'BOOTSTRAP_TOKEN:atomicity-bootstrap'],
  });

  const bootstrap = await bootstrapAdmin(runtime, { token: 'atomicity-bootstrap', displayName: '原子性管理员' });
  assert.equal(bootstrap.response.status, 201);
  adminCookie = cookiePair(bootstrap.response.headers.get('set-cookie'));

  const created = await createMember(runtime, adminCookie, {
    username: 'atomic-member', displayName: '原子性成员',
    scopes: [{ type: 'project', id: 'project-old' }],
  });
  assert.equal(created.response.status, 201);
  member = created.body.data;

  successfulKey = `atomic-update-${crypto.randomUUID()}`;
  const updated = await jsonRequest(runtime, `/api/members/${member.id}`, mutation('PATCH', {
    expectedVersion: 1,
    role: 'project_manager',
    scopes: [{ type: 'framework', id: 'framework-new' }],
  }, { Cookie: adminCookie, 'Idempotency-Key': successfulKey }));
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

  const stale = await jsonRequest(runtime, `/api/members/${member.id}`, mutation('PATCH', {
    expectedVersion: 1,
    role: 'finance',
    scopes: [{ type: 'project', id: 'project-should-not-exist' }],
  }, { Cookie: adminCookie, 'Idempotency-Key': staleKey }));
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

  const replay = await jsonRequest(runtime, `/api/members/${member.id}`, mutation('PATCH', {
    expectedVersion: 1,
    role: 'project_manager',
    scopes: [{ type: 'framework', id: 'framework-new' }],
  }, { Cookie: adminCookie, 'Idempotency-Key': successfulKey }));
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.data.version, 2);

  assert.equal(rows(`SELECT COUNT(*) AS count FROM audit_events WHERE object_type='member' AND object_id='${member.id}' AND action='member.update';`)[0].count, auditBefore);
  assert.equal(rows(`SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='${successfulKey}';`)[0].count, idemBefore);
});
