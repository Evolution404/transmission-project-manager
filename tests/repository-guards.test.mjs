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

function collectSourceFiles(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...collectSourceFiles(path));
    else if (/\.(vue|ts)$/.test(name)) files.push(path);
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

test('portable backend core cannot depend on Cloudflare runtime types', () => {
  const requiredPorts = ['database.ts', 'object-store.ts', 'job-queue.ts', 'scheduler.ts', 'clock.ts', 'attachment-repository.ts'];
  for (const name of requiredPorts) {
    assert.equal(existsSync(resolve(root, 'apps/api/src/ports', name)), true, `缺少可移植后端端口 ${name}`);
  }
  const portableRoots = ['domain', 'application', 'ports', 'repositories']
    .map((name) => resolve(root, 'apps/api/src', name))
    .filter((directory) => existsSync(directory));
  const forbidden = /\b(?:D1Database|D1PreparedStatement|R2Bucket|Fetcher|ExecutionContext)\b|@cloudflare\/workers-types|\bwrangler\b|cloudflare:/i;
  for (const directory of portableRoots) {
    for (const file of collectSourceFiles(directory)) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, forbidden, `${file} 将可移植核心重新绑定到 Cloudflare runtime`);
    }
  }
});

test('P5 attachment content no longer reaches the R2 binding directly', () => {
  const source = readFileSync(resolve(root, 'apps/api/src/p5.ts'), 'utf8');
  assert.doesNotMatch(source, /c\.env\.FILES/, 'P5 attachment content must use ObjectStorePort instead of the R2 binding directly');
});

test('P5 attachment metadata goes through AttachmentRepository instead of inline SQL', () => {
  const source = readFileSync(resolve(root, 'apps/api/src/p5.ts'), 'utf8');
  assert.match(source, /SqlAttachmentRepository/, 'P5 attachments must use the shared repository contract');
  assert.doesNotMatch(source, /\b(?:FROM|INTO)\s+attachments\b/i, 'P5 must not inline attachment metadata SQL');
});

test('authentication middleware uses portable session and member repositories', () => {
  const source = readFileSync(resolve(root, 'apps/api/src/auth.ts'), 'utf8');
  assert.match(source, /SqlSessionRepository/);
  assert.match(source, /SqlMemberRepository/);
  assert.doesNotMatch(source, /c\.env\.DB|\bD1Database\b/, 'auth middleware must not depend directly on D1');
});

test('Cloudflare infrastructure adapters depend inward on portable ports', () => {
  const adapters = [
    ['d1-database.ts', /implements\s+DatabasePort/, /ports\/database/],
    ['r2-object-store.ts', /implements\s+ObjectStorePort/, /ports\/object-store/],
  ];
  for (const [name, contract, portImport] of adapters) {
    const file = resolve(root, 'apps/api/src/adapters/cloudflare', name);
    assert.equal(existsSync(file), true, `缺少 Cloudflare adapter ${name}`);
    const source = readFileSync(file, 'utf8');
    assert.match(source, contract);
    assert.match(source, portImport);
  }
});

test('business batch import is never the only creation path for demand data', () => {
  const apiSource = readFileSync(resolve(root, 'apps/api/src/p2.ts'), 'utf8');
  const webSource = readFileSync(resolve(root, 'apps/web/src/views/DemandsView.vue'), 'utf8');
  assert.match(apiSource, /post\('\/imports'/, '需求存在批量导入时必须保留导入接口');
  assert.match(readFileSync(resolve(root, 'apps/api/src/p9.ts'), 'utf8'), /post\('\/demands'/, '需求支持批量导入时必须同时支持服务端手工新增');
  assert.match(webSource, /data-test="manual-demand-form"/, '需求支持批量导入时必须同时支持服务端手工新增入口');
  assert.match(webSource, /data-test="open-manual-demand"/, '手工新增需求必须由明确操作打开，不能把整张新增表单常驻主页面');
});

test('web form defaults are Chinese and English default placeholders are forbidden', () => {
  const appSource = readFileSync(resolve(root, 'apps/web/src/App.vue'), 'utf8');
  assert.match(appSource, /\bzhCN\b/);
  assert.match(appSource, /\bdateZhCN\b/);
  assert.match(appSource, /:locale="zhCN"/);
  assert.match(appSource, /:date-locale="dateZhCN"/);

  for (const file of collectSourceFiles(resolve(root, 'apps/web/src'))) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /Please\s+(?:Input|Select|Upload|Choose|Enter)/i, `${file} 出现英文默认表单占位文案`);
    for (const match of source.matchAll(/(?:^|\s):?placeholder="([^"]+)"/g)) {
      assert.match(match[1], /[\u3400-\u9fff]/, `${file} 存在不含中文的显式 placeholder：${match[1]}`);
    }
  }
});

test('mobile UI keeps usable navigation and dashboard density', () => {
  const appSource = readFileSync(resolve(root, 'apps/web/src/App.vue'), 'utf8');
  const dashboardSource = readFileSync(resolve(root, 'apps/web/src/views/DashboardView.vue'), 'utf8');
  const styleSource = readFileSync(resolve(root, 'apps/web/src/styles.css'), 'utf8');
  assert.match(appSource, /mobile-menu-button/);
  assert.match(appSource, /n-drawer/);
  assert.match(styleSource, /@media \(max-width: 720px\)/);
  assert.match(styleSource, /\.mobile-menu-button \{ display: inline-flex !important; \}/);
  assert.match(dashboardSource, /metrics-grid/);
  assert.match(dashboardSource, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(dashboardSource, /:cols="5"/);
});

test('local API development automatically applies and watches migrations', () => {
  const apiPackage = JSON.parse(readFileSync(resolve(root, 'apps/api/package.json'), 'utf8'));
  assert.equal(apiPackage.scripts.dev, 'node ../../scripts/dev/api-dev.mjs');
  const source = readFileSync(resolve(root, 'scripts/dev/api-dev.mjs'), 'utf8');
  assert.match(source, /migrations/);
  assert.match(source, /watch\(/);
  assert.match(source, /'d1',\s*'migrations',\s*'apply'/);
});

test('schema readiness guard always targets the latest committed migration', () => {
  const latestMigration = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .at(-1);
  assert.ok(latestMigration);
  const source = readFileSync(resolve(root, 'apps/api/src/schema.ts'), 'utf8');
  assert.match(source, new RegExp(`REQUIRED_MIGRATION\\s*=\\s*['\"]${latestMigration.replaceAll('.', '\\.')}['\"]`));
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

test('Node integration suite is safe for file-level parallelism', () => {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const match = packageJson.scripts?.['test:node']?.match(/--test-concurrency=(\d+)/);
  assert.ok(match, 'test:node must declare explicit file-level concurrency');
  assert.ok(Number(match[1]) >= 5, 'test:node should run at least five test files in parallel');

  const wranglerHelper = readFileSync(resolve(root, 'tests/helpers/wrangler.mjs'), 'utf8');
  assert.match(wranglerHelper, /'--inspector-port'/, 'parallel Wrangler runtimes need isolated inspector ports');

  const migrationTests = readFileSync(resolve(root, 'tests/migrations.test.mjs'), 'utf8');
  assert.match(migrationTests, /node:sqlite/, 'migration data-preservation tests should avoid one Wrangler process per SQL statement');
  assert.match(migrationTests, /applyWranglerMigrations/, 'migration tests must retain a real Wrangler migration smoke path');

  const ports = new Map();
  for (const file of collectTestFiles(resolve(root, 'tests'))) {
    const source = readFileSync(file, 'utf8');
    for (const portMatch of source.matchAll(/\bport:\s*(\d+)\b/g)) {
      const port = Number(portMatch[1]);
      const previous = ports.get(port);
      assert.equal(previous, undefined, `integration test port ${port} is reused by ${previous} and ${file}`);
      ports.set(port, file);
    }
  }
});
