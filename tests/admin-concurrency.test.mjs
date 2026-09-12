import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanupStateDir, makeStateDir, queryLocalD1, startWranglerServer } from './helpers/wrangler.mjs';
import {
  bootstrapAdmin, cookiePair, createMember, fixedCredential, fixedSalt, jsonRequest, loginWithCredential, mutation,
} from './helpers/auth.mjs';

const stateDir = makeStateDir('tpm-admin-race-');
let runtime;
let firstAdmin;
let secondAdmin;
let firstCookie;
let secondCookie;

before(async () => {
  runtime = await startWranglerServer({
    stateDir, port: 8801, migrate: true,
    vars: ['AUTH_CREDENTIAL_PEPPER:race-pepper', 'BOOTSTRAP_TOKEN:race-bootstrap'],
  });

  const bootstrap = await bootstrapAdmin(runtime, {
    token: 'race-bootstrap', displayName: '并发管理员 A', salt: fixedSalt(1), credential: fixedCredential(1),
  });
  assert.equal(bootstrap.response.status, 201);
  firstAdmin = bootstrap.body.data;
  firstCookie = cookiePair(bootstrap.response.headers.get('set-cookie'));

  const create = await createMember(runtime, firstCookie, {
    username: 'admin-b', displayName: '并发管理员 B', role: 'admin',
    salt: fixedSalt(2), credential: fixedCredential(2), scopes: [{ type: 'all', id: null }],
  });
  assert.equal(create.response.status, 201);
  secondAdmin = create.body.data;

  const login = await loginWithCredential(runtime, 'admin-b', fixedCredential(2));
  assert.equal(login.response.status, 200);
  const initialCookie = cookiePair(login.response.headers.get('set-cookie'));
  const changed = await jsonRequest(runtime, '/api/auth/change-password', mutation('POST', {
    currentCredential: fixedCredential(2),
    next: { salt: fixedSalt(3), credential: fixedCredential(3) },
  }, { Cookie: initialCookie }));
  assert.equal(changed.response.status, 200);
  secondCookie = cookiePair(changed.response.headers.get('set-cookie'));
}, { timeout: 80000 });

after(async () => {
  await runtime?.stop();
  cleanupStateDir(stateDir);
});

test('concurrent demotions can never leave the system with zero enabled administrators', async () => {
  const [demoteA, demoteB] = await Promise.all([
    jsonRequest(runtime, `/api/members/${firstAdmin.id}`, mutation('PATCH', {
      expectedVersion: firstAdmin.version, role: 'readonly', scopes: [],
    }, { Cookie: secondCookie, 'Idempotency-Key': `race-a-${crypto.randomUUID()}` })),
    jsonRequest(runtime, `/api/members/${secondAdmin.id}`, mutation('PATCH', {
      expectedVersion: secondAdmin.version, role: 'readonly', scopes: [],
    }, { Cookie: firstCookie, 'Idempotency-Key': `race-b-${crypto.randomUUID()}` })),
  ]);

  const successCount = [demoteA, demoteB].filter((item) => item.response.status === 200).length;
  const rows = queryLocalD1(stateDir, "SELECT COUNT(*) AS count FROM members WHERE enabled=1 AND role='admin';")
    .flatMap((entry) => entry.results ?? []);

  assert.equal(rows[0].count, 1, `并发结果不得把管理员归零；HTTP=${demoteA.response.status}/${demoteB.response.status}`);
  assert.equal(successCount, 1, '两个并发降权请求必须恰好一个成功');
});
