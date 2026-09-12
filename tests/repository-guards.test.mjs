import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const migrationsDir = resolve(root, 'apps/api/migrations');
const lock = JSON.parse(readFileSync(resolve(root, 'tests/migrations.lock.json'), 'utf8'));

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('published migrations are append-only and checksum locked', () => {
  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const lockedFiles = Object.keys(lock).map((path) => basename(path)).sort();
  assert.deepEqual(
    migrationFiles,
    lockedFiles,
    '新增迁移时必须先追加迁移文件，再显式更新 tests/migrations.lock.json；禁止静默修改/遗漏旧迁移',
  );

  for (const [relativePath, expectedHash] of Object.entries(lock)) {
    assert.equal(
      sha256(resolve(root, relativePath)),
      expectedHash,
      `${relativePath} 已发布，禁止修改旧迁移；请新增下一编号迁移`,
    );
  }
});

test('production migrations never contain synthetic local identities', () => {
  for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith('.sql'))) {
    const sql = readFileSync(resolve(migrationsDir, name), 'utf8').toLowerCase();
    assert.doesNotMatch(sql, /example\.invalid|dev-admin|dev-readonly|dev-disabled/, `${name} 混入本地测试身份`);
  }
});

test('local synthetic identities stay isolated in the seed file', () => {
  const seed = readFileSync(resolve(root, 'apps/api/seeds/local.sql'), 'utf8');
  assert.match(seed, /example\.invalid/);
  assert.match(seed, /dev-admin@example\.invalid/);
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
