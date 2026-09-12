import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanupStateDir, makeStateDir, startWranglerServer } from './helpers/wrangler.mjs';
import { bootstrapAdmin, fixedCredential, fixedSalt, jsonRequest, loginWithCredential } from './helpers/auth.mjs';

const stateDir = makeStateDir('tpm-p1-2-prod-auth-');
let runtime;
const bootstrapToken = 'production-mode-bootstrap-test-secret';
const pepper = 'production-mode-pepper-test-only';
const credential = fixedCredential(7);

before(async () => {
  runtime = await startWranglerServer({
    stateDir,
    port: 8806,
    seed: false,
    migrate: true,
    vars: [
      'APP_ENV:production',
      `AUTH_CREDENTIAL_PEPPER:${pepper}`,
      `BOOTSTRAP_TOKEN:${bootstrapToken}`,
    ],
  });
}, { timeout: 80000 });

after(async () => {
  await runtime?.stop();
  cleanupStateDir(stateDir);
});

test('production bootstrap and login work without Cloudflare Access configuration', async () => {
  const bootstrap = await bootstrapAdmin(runtime, {
    token: bootstrapToken,
    username: 'prod-admin',
    displayName: '生产管理员',
    salt: fixedSalt(7),
    credential,
  });
  assert.equal(bootstrap.response.status, 201);
  const bootstrapCookie = bootstrap.response.headers.get('set-cookie') ?? '';
  assert.match(bootstrapCookie, /HttpOnly/i);
  assert.match(bootstrapCookie, /SameSite=Strict/i);
  assert.match(bootstrapCookie, /;\s*Secure/i, 'production session cookie must be Secure');

  const login = await loginWithCredential(runtime, 'prod-admin', credential);
  assert.equal(login.response.status, 200);
  assert.equal(login.body.data.username, 'prod-admin');
  assert.match(login.response.headers.get('set-cookie') ?? '', /;\s*Secure/i);
});

test('production ignores legacy dev/access identity headers when there is no system session', async () => {
  for (const headers of [
    { 'X-Dev-User-Email': 'dev-admin@example.invalid' },
    { 'Cf-Access-Jwt-Assertion': 'not-a-real-jwt' },
    { 'X-Dev-User-Email': 'dev-admin@example.invalid', 'Cf-Access-Jwt-Assertion': 'not-a-real-jwt' },
  ]) {
    const response = await jsonRequest(runtime, '/api/me', { headers });
    assert.equal(response.response.status, 401);
    assert.equal(response.body.error.code, 'UNAUTHENTICATED');
  }
});
