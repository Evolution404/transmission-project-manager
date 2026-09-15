import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanupStateDir, makeStateDir, queryLocalD1, startWranglerServer } from './helpers/wrangler.mjs';
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

const stateDir = makeStateDir('tpm-p1-2-auth-');
let runtime;
let adminCookie = '';
let adminId = '';

const bootstrapToken = 'p1-2-bootstrap-test-secret';
const pepper = 'p1-2-test-pepper-not-for-production';
const adminCredential = fixedCredential(1);
const userInitialCredential = fixedCredential(2);
const userChangedCredential = fixedCredential(3);
const userResetCredential = fixedCredential(4);
const wrongCredential = fixedCredential(9);

before(async () => {
  runtime = await startWranglerServer({
    stateDir,
    port: 8805,
    seed: false,
    migrate: true,
    vars: [
      `AUTH_CREDENTIAL_PEPPER:${pepper}`,
      `BOOTSTRAP_TOKEN:${bootstrapToken}`,
    ],
  });
}, { timeout: 80000 });

after(async () => {
  await runtime?.stop();
  cleanupStateDir(stateDir);
});

test('bootstrap requires deployment secret, creates one local administrator, and closes permanently', async () => {
  const wrong = await bootstrapAdmin(runtime, { token: 'wrong-secret' });
  assert.equal(wrong.response.status, 403);
  assert.equal(wrong.body.error.code, 'BOOTSTRAP_FORBIDDEN');

  const created = await bootstrapAdmin(runtime, {
    token: bootstrapToken,
    credential: adminCredential,
    salt: fixedSalt(1),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.username, 'admin');
  assert.equal(created.body.data.displayName, '系统管理员');
  assert.equal(created.body.data.role, 'admin');
  assert.equal(created.body.data.mustChangePassword, false);
  assert.equal(Object.hasOwn(created.body.data, 'email'), false);
  adminId = created.body.data.id;

  const setCookie = created.response.headers.get('set-cookie');
  assert.match(setCookie ?? '', /HttpOnly/i);
  assert.match(setCookie ?? '', /SameSite=Strict/i);
  assert.match(setCookie ?? '', /Path=\//i);
  assert.match(setCookie ?? '', /Max-Age=604800/i);
  assert.doesNotMatch(setCookie ?? '', /;\s*Secure/i, 'local HTTP development cookie must remain usable');
  adminCookie = cookiePair(setCookie);

  const second = await bootstrapAdmin(runtime, { token: bootstrapToken, username: 'other-admin' });
  assert.equal(second.response.status, 409);
  assert.equal(second.body.error.code, 'BOOTSTRAP_CLOSED');
});

test('KDF descriptor exposes only public Argon2id parameters and does not disclose account existence', async () => {
  const known = await jsonRequest(runtime, '/api/auth/kdf', mutation('POST', { username: 'admin' }));
  const unknown = await jsonRequest(runtime, '/api/auth/kdf', mutation('POST', { username: 'does-not-exist' }));
  assert.equal(known.response.status, 200);
  assert.equal(unknown.response.status, 200);
  for (const item of [known.body.data, unknown.body.data]) {
    assert.equal(item.algorithm, 'argon2id-v1');
    assert.equal(item.memoryCostKiB, 19456);
    assert.equal(item.timeCost, 2);
    assert.equal(item.parallelism, 1);
    assert.equal(item.hashLength, 32);
    assert.equal(typeof item.salt, 'string');
    assert.ok(item.salt.length >= 22);
  }
  assert.notEqual(known.body.data.salt, unknown.body.data.salt);
});

test('anonymous requests are rejected while a server session resolves username, role and scopes', async () => {
  const anonymous = await jsonRequest(runtime, '/api/me');
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.body.error.code, 'UNAUTHENTICATED');

  const authenticated = await jsonRequest(runtime, '/api/me', { headers: { Cookie: adminCookie } });
  assert.equal(authenticated.response.status, 200);
  assert.equal(authenticated.body.data.id, adminId);
  assert.equal(authenticated.body.data.username, 'admin');
  assert.equal(authenticated.body.data.role, 'admin');
  assert.deepEqual(authenticated.body.data.scopes, [{ type: 'all', id: null }]);
  assert.equal(authenticated.body.data.authSource, 'session');
  assert.equal(Object.hasOwn(authenticated.body.data, 'email'), false);
});

test('administrator creates an account without email and usernames are case-insensitive unique', async () => {
  const key = `create-${crypto.randomUUID()}`;
  const created = await createMember(runtime, adminCookie, {
    username: 'zhangsan',
    displayName: '张三',
    salt: fixedSalt(2),
    credential: userInitialCredential,
    scopes: [{ type: 'project', id: 'synthetic-project-a' }],
    idempotencyKey: key,
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.username, 'zhangsan');
  assert.equal(created.body.data.mustChangePassword, true);
  assert.equal(created.body.data.lifecycleStatus, 'pending_first_login');
  assert.equal(Object.hasOwn(created.body.data, 'email'), false);

  const replay = await createMember(runtime, adminCookie, {
    username: 'zhangsan', displayName: '张三', salt: fixedSalt(2), credential: userInitialCredential,
    scopes: [{ type: 'project', id: 'synthetic-project-a' }], idempotencyKey: key,
  });
  assert.equal(replay.response.status, 201);
  assert.deepEqual(replay.body, created.body);

  const duplicate = await createMember(runtime, adminCookie, {
    username: 'ZHANGSAN', displayName: '重复账号', salt: fixedSalt(5), credential: fixedCredential(5),
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error.code, 'USERNAME_EXISTS');
});

test('database stores a server-peppered verifier and hashed session token, never the browser credential', () => {
  const rows = queryLocalD1(stateDir,
    "SELECT username,credential_salt,credential_verifier,credential_algorithm,credential_params_json,must_change_password FROM members ORDER BY username",
  )[0].results;
  const admin = rows.find((row) => row.username === 'admin');
  const user = rows.find((row) => row.username === 'zhangsan');
  assert.ok(admin && user);
  for (const row of [admin, user]) {
    assert.equal(row.credential_algorithm, 'argon2id-v1');
    const params = JSON.parse(row.credential_params_json);
    assert.deepEqual(params, {
      algorithm: 'argon2id-v1', memoryCostKiB: 19456, timeCost: 2,
      parallelism: 1, hashLength: 32, version: 19,
    });
    assert.ok(row.credential_salt.length >= 22);
    assert.ok(row.credential_verifier.length >= 43);
  }
  assert.notEqual(admin.credential_verifier, adminCredential);
  assert.notEqual(user.credential_verifier, userInitialCredential);
  assert.notEqual(admin.credential_salt, user.credential_salt);

  const sessions = queryLocalD1(stateDir, 'SELECT token_hash FROM auth_sessions WHERE revoked_at IS NULL')[0].results;
  assert.ok(sessions.length >= 1);
  const rawAdminToken = adminCookie.split('=', 2)[1];
  assert.ok(rawAdminToken.length >= 40);
  assert.ok(sessions.every((row) => row.token_hash !== rawAdminToken));
});

test('unknown username and wrong credential return the same generic authentication error', async () => {
  const unknown = await loginWithCredential(runtime, 'does-not-exist', wrongCredential);
  const wrong = await loginWithCredential(runtime, 'zhangsan', wrongCredential);
  for (const result of [unknown, wrong]) {
    assert.equal(result.response.status, 401);
    assert.equal(result.body.error.code, 'INVALID_CREDENTIALS');
    assert.equal(result.body.error.message, '账号或密码错误');
  }
});

test('initial account is restricted until credential change, and old sessions are revoked', async () => {
  const loggedIn = await loginWithCredential(runtime, 'zhangsan', userInitialCredential);
  assert.equal(loggedIn.response.status, 200);
  assert.equal(loggedIn.body.data.mustChangePassword, true);
  const oldCookie = cookiePair(loggedIn.response.headers.get('set-cookie'));

  const blocked = await jsonRequest(runtime, '/api/settings', { headers: { Cookie: oldCookie } });
  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');

  const changed = await jsonRequest(runtime, '/api/auth/change-password', mutation('POST', {
    currentCredential: userInitialCredential,
    next: { salt: fixedSalt(3), credential: userChangedCredential },
  }, { Cookie: oldCookie }));
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.data.mustChangePassword, false);
  const newCookie = cookiePair(changed.response.headers.get('set-cookie'));

  const oldSession = await jsonRequest(runtime, '/api/me', { headers: { Cookie: oldCookie } });
  assert.equal(oldSession.response.status, 401);

  const allowed = await jsonRequest(runtime, '/api/settings', { headers: { Cookie: newCookie } });
  assert.equal(allowed.response.status, 200);
});

test('logout revokes the current session immediately', async () => {
  const loggedIn = await loginWithCredential(runtime, 'zhangsan', userChangedCredential);
  assert.equal(loggedIn.response.status, 200);
  const cookie = cookiePair(loggedIn.response.headers.get('set-cookie'));

  const logout = await jsonRequest(runtime, '/api/auth/logout', mutation('POST', {}, { Cookie: cookie }));
  assert.equal(logout.response.status, 200);
  assert.match(logout.response.headers.get('set-cookie') ?? '', /Max-Age=0/i);
  const after = await jsonRequest(runtime, '/api/me', { headers: { Cookie: cookie } });
  assert.equal(after.response.status, 401);
});

test('administrator credential reset invalidates old sessions and requires another change', async () => {
  const loggedIn = await loginWithCredential(runtime, 'zhangsan', userChangedCredential);
  const oldCookie = cookiePair(loggedIn.response.headers.get('set-cookie'));
  const members = await jsonRequest(runtime, '/api/members', { headers: { Cookie: adminCookie } });
  const user = members.body.data.items.find((item) => item.username === 'zhangsan');
  assert.ok(user);

  const reset = await jsonRequest(runtime, `/api/members/${user.id}/reset-password`, mutation('POST', {
    salt: fixedSalt(4), credential: userResetCredential,
  }, { Cookie: adminCookie, 'Idempotency-Key': `reset-${crypto.randomUUID()}` }));
  assert.equal(reset.response.status, 200);
  assert.equal(reset.body.data.mustChangePassword, true);

  const stale = await jsonRequest(runtime, '/api/me', { headers: { Cookie: oldCookie } });
  assert.equal(stale.response.status, 401);
  assert.equal((await loginWithCredential(runtime, 'zhangsan', userChangedCredential)).response.status, 401);
  const newCredential = await loginWithCredential(runtime, 'zhangsan', userResetCredential);
  assert.equal(newCredential.response.status, 200);
  assert.equal(newCredential.body.data.mustChangePassword, true);
});

test('disabling an account makes its existing session unusable on the next request', async () => {
  const loggedIn = await loginWithCredential(runtime, 'zhangsan', userResetCredential);
  const userCookie = cookiePair(loggedIn.response.headers.get('set-cookie'));
  const members = await jsonRequest(runtime, '/api/members', { headers: { Cookie: adminCookie } });
  const user = members.body.data.items.find((item) => item.username === 'zhangsan');

  const disabled = await jsonRequest(runtime, `/api/members/${user.id}`, mutation('PATCH', {
    expectedVersion: user.version, enabled: false,
  }, { Cookie: adminCookie, 'Idempotency-Key': `disable-${crypto.randomUUID()}` }));
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.body.data.enabled, false);

  const after = await jsonRequest(runtime, '/api/me', { headers: { Cookie: userCookie } });
  assert.equal(after.response.status, 401);
  assert.equal(after.body.error.code, 'UNAUTHENTICATED');
});

test('repeated failed logins lock the account without changing the generic response', async () => {
  const created = await createMember(runtime, adminCookie, {
    username: 'lock-user', displayName: '锁定测试', salt: fixedSalt(6), credential: fixedCredential(6),
  });
  assert.equal(created.response.status, 201);

  for (let index = 0; index < 5; index += 1) {
    const failed = await loginWithCredential(runtime, 'lock-user', wrongCredential);
    assert.equal(failed.response.status, 401);
    assert.equal(failed.body.error.code, 'INVALID_CREDENTIALS');
  }
  const lockedCorrect = await loginWithCredential(runtime, 'lock-user', fixedCredential(6));
  assert.equal(lockedCorrect.response.status, 401);
  assert.equal(lockedCorrect.body.error.code, 'INVALID_CREDENTIALS');

  const rows = queryLocalD1(stateDir,
    "SELECT failed_login_count,locked_until FROM members WHERE username='lock-user'",
  )[0].results;
  assert.equal(rows[0].failed_login_count, 5);
  assert.ok(rows[0].locked_until);
});
