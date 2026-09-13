import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const migrationsDir = resolve(root, 'apps/api/migrations');
const lock = JSON.parse(readFileSync(resolve(root, 'tests/migrations.lock.json'), 'utf8'));

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('current development migration baseline is explicitly checksum locked', () => {
  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const lockedFiles = Object.keys(lock).map((path) => basename(path)).sort();
  assert.deepEqual(
    migrationFiles,
    lockedFiles,
    '开发期重整迁移后必须显式同步 tests/migrations.lock.json；不得留下已删除或未纳入门禁的迁移',
  );

  for (const [relativePath, expectedHash] of Object.entries(lock)) {
    assert.equal(
      sha256(resolve(root, relativePath)),
      expectedHash,
      `${relativePath} 与当前开发基线不一致；如属明确的开发期 schema 重整，请同步更新迁移锁`,
    );
  }
});

test('production migrations never contain synthetic local identities', () => {
  for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith('.sql'))) {
    const sql = readFileSync(resolve(migrationsDir, name), 'utf8').toLowerCase();
    assert.doesNotMatch(sql, /example\.invalid|dev-admin|dev-readonly|dev-disabled/, `${name} 混入本地测试身份`);
  }
});

test('development no longer injects synthetic account seed data', () => {
  assert.equal(existsSync(resolve(root, 'apps/api/seeds/local.sql')), false);
  const apiPackage = readFileSync(resolve(root, 'apps/api/package.json'), 'utf8');
  assert.doesNotMatch(apiPackage, /seeds\/local\.sql/);
});

function collectTestFiles(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...collectTestFiles(path));
    else if (/\.(test\.(mjs|ts)|spec\.(mjs|ts))$/.test(name)) files.push(path);
  }
  return files;
}

test('P1.2 runtime authentication does not depend on Cloudflare Access or email identity headers', () => {
  const runtimeFiles = [
    resolve(root, 'apps/api/src/auth.ts'),
    resolve(root, 'apps/api/src/env.ts'),
    resolve(root, 'apps/api/wrangler.jsonc'),
    resolve(root, 'apps/api/package.json'),
  ];
  const source = runtimeFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(source, /Cf-Access-Jwt-Assertion/);
  assert.doesNotMatch(source, /ACCESS_TEAM_DOMAIN|ACCESS_AUD|DEV_AUTH_EMAIL|BOOTSTRAP_ADMIN_EMAIL/);
  assert.doesNotMatch(source, /from ['\"]jose['\"]|\"jose\"\s*:/);
});

test('business batch import is never the only creation path for demand data', () => {
  const apiSource = readFileSync(resolve(root, 'apps/api/src/p2.ts'), 'utf8');
  const webSource = readFileSync(resolve(root, 'apps/web/src/views/DemandsView.vue'), 'utf8');
  assert.match(apiSource, /post\('\/imports'/, '需求存在批量导入时必须保留导入接口');
  assert.match(apiSource, /post\('\/demands'/, '需求支持批量导入时必须同时支持服务端手工新增');
  assert.match(webSource, /data-test="manual-demand-form"/, '需求支持批量导入时必须同时提供前端手工新增入口');
});

test('server authentication never performs the browser-side slow KDF', () => {
  const files = readdirSync(resolve(root, 'apps/api/src'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(resolve(root, 'apps/api/src', name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(files, /@phi-ag\/argon2|PBKDF2|deriveBits\s*\(/);
  const webAuth = readFileSync(resolve(root, 'apps/web/src/auth/credential-worker.ts'), 'utf8');
  assert.match(webAuth, /Argon2id/);
});

test('committed tests cannot silently bypass the quality gate', () => {
  const files = [
    ...collectTestFiles(resolve(root, 'tests')),
    ...collectTestFiles(resolve(root, 'apps/web/tests')),
  ];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\b(?:test|it|describe)\.(?:skip|only|todo)\s*\(/, `${file} contains a skipped/isolated test`);
    assert.doesNotMatch(source, /\b(?:test|it)\.todo\s*\(/, `${file} contains test.todo`);
  }
});
