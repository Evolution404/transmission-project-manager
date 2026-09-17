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

function relativeLuminance(hex) {
  const rgb = hex.match(/[a-f\d]{2}/gi)?.map((part) => Number.parseInt(part, 16) / 255) ?? [];
  assert.equal(rgb.length, 3, `无效颜色：${hex}`);
  const [r, g, b] = rgb.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test('development schema stays on one resettable baseline until the user explicitly enters operation stage', () => {
  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  assert.deepEqual(
    migrationFiles,
    ['0001_initial_schema.sql'],
    '当前仍是开发阶段：历史数据保留通过发布期数据迁移解决，不得因此新增 0002+ migration；只有用户明确宣布进入运行阶段/正式维护升级链后才允许推进版本',
  );

  const lockedFiles = Object.keys(lock).map((path) => basename(path)).sort();
  assert.deepEqual(lockedFiles, migrationFiles, '迁移锁必须只覆盖唯一开发基线');
  for (const [relativePath, expectedHash] of Object.entries(lock)) {
    assert.equal(
      sha256(resolve(root, relativePath)),
      expectedHash,
      `${relativePath} 与唯一开发基线不一致；开发期 schema 重整必须同步更新该单一 checksum`,
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

test('runtime authentication does not depend on Cloudflare Access or email identity headers', () => {
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

test('HTTP business and authentication modules resolve persistence without importing Cloudflare adapters', () => {
  const files = [
    'app.ts', 'account.ts', 'administration.ts', 'auth.ts', 'authentication-context.ts', 'public-authentication.ts', 'session.ts', 'demand-import.ts', 'reserve-planning.ts', 'finance.ts',
    'project-lifecycle.ts', 'analysis-operations.ts', 'project-execution.ts', 'project-execution-query.ts', 'project-execution-shared.ts', 'project-delivery.ts', 'project-task-progress.ts', 'transmission-grid.ts', 'transmission-grid-operations.ts', 'master-data-config.ts', 'physical-towers.ts', 'structured-demand.ts',
  ];
  for (const name of files) {
    const source = readFileSync(resolve(root, 'apps/api/src', name), 'utf8');
    assert.doesNotMatch(source, /runtime\/cloudflare\/persistence/, `${name} must resolve runtime-neutral persistence`);
  }
  const appSource = readFileSync(resolve(root, 'apps/api/src/app.ts'), 'utf8');
  assert.doesNotMatch(appSource, /c\.env\.DB|\bD1(?:Database|PreparedStatement)\b|\.prepare\(/, 'top-level HTTP app must not reach D1 directly');
});

test('production code and tests use semantic module names instead of numbered implementation stages', () => {
  const numberedFileName = /^p\d+(?:-\d+)?(?:[-_.]|$)/i;
  const numberedPathSegment = /[\\/]p\d+(?:-\d+)?(?:[\\/]|$)/i;
  for (const directory of [resolve(root, 'apps'), resolve(root, 'packages'), resolve(root, 'tests'), resolve(root, 'scripts')]) {
    for (const file of collectSourceFiles(directory)) {
      const name = file.split('/').at(-1) ?? '';
      assert.equal(numberedFileName.test(name), false, `${file} 使用阶段编号作为代码文件名；请改成业务语义名称`);
      assert.equal(numberedPathSegment.test(file), false, `${file} 使用阶段编号作为代码目录；请改成业务语义名称`);
    }
  }

  for (const file of collectSourceFiles(resolve(root, 'apps/api/src'))) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\b(?:p\d+App|runP\d+[A-Z]\w*)\b/, `${file} 使用阶段编号作为生产代码标识符`);
    assert.doesNotMatch(source, /from\s+['"]\.\/p\d+(?:-\d+)?\.ts['"]/, `${file} 仍导入阶段编号模块`);
    assert.doesNotMatch(source, /\bstage\s*:\s*['"]p\d+['"]/i, `${file} 把实现阶段编号暴露为生产合同`);
  }
});

test('project lifecycle attachment content no longer reaches the R2 binding directly', () => {
  const source = readFileSync(resolve(root, 'apps/api/src/project-lifecycle.ts'), 'utf8');
  assert.doesNotMatch(source, /c\.env\.FILES/, 'project lifecycle attachment content must use ObjectStorePort instead of the R2 binding directly');
});

test('project lifecycle attachment metadata goes through AttachmentRepository instead of inline SQL', () => {
  const source = readFileSync(resolve(root, 'apps/api/src/project-lifecycle.ts'), 'utf8');
  assert.match(source, /SqlAttachmentRepository/, 'project lifecycle attachments must use the shared repository contract');
  assert.doesNotMatch(source, /\b(?:FROM|INTO)\s+attachments\b/i, 'project lifecycle routes must not inline attachment metadata SQL');
});

test('transmission grid, master-data configuration, physical tower, and structured demand flows do not reach D1 directly', () => {
  for (const name of ['transmission-grid.ts', 'transmission-grid-operations.ts', 'master-data-config.ts', 'physical-towers.ts', 'structured-demand.ts']) {
    const source = readFileSync(resolve(root, 'apps/api/src', name), 'utf8');
    assert.doesNotMatch(source, /c\.env\.DB|\bD1(?:Database|PreparedStatement)\b/, `${name} must use portable repositories instead of D1 APIs directly`);
  }
});

test('master-data write repository facade delegates mutation SQL to focused modules', () => {
  const source = readFileSync(resolve(root, 'apps/api/src/repositories/sql-master-data-write-repository.ts'), 'utf8');
  assert.match(source, /master-data-write\/single-master-write/);
  assert.match(source, /master-data-write\/transmission-grid-write/);
  assert.match(source, /master-data-write\/master-config-write/);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?/i, 'master-data write facade must not absorb mutation SQL again');
});

test('HTTP modules share one idempotency request/replay implementation', () => {
  const modules = ['administration.ts', 'demand-import.ts', 'reserve-planning.ts', 'finance.ts', 'project-lifecycle.ts', 'analysis-operations.ts', 'project-execution.ts', 'project-delivery.ts', 'project-task-progress.ts'];
  for (const name of modules) {
    const source = readFileSync(resolve(root, 'apps/api/src', name), 'utf8');
    assert.match(source, /http\/idempotent-mutation/, `${name} must use the shared idempotency helper`);
    assert.doesNotMatch(source, /function\s+(?:requireIdempotencyKey|requestHash|replayIdempotentResponse)\b/, `${name} must not duplicate idempotency helpers`);
    assert.doesNotMatch(source, /SqlIdempotencyRepository/, `${name} must not perform idempotency replay directly`);
  }
});

test('HTTP modules share the common API error response builder', () => {
  const modules = ['app.ts', 'account.ts', 'administration.ts', 'public-authentication.ts', 'demand-import.ts', 'reserve-planning.ts', 'finance.ts', 'project-lifecycle.ts', 'analysis-operations.ts', 'project-execution.ts', 'project-execution-query.ts', 'project-delivery.ts', 'project-task-progress.ts'];
  for (const name of modules) {
    const source = readFileSync(resolve(root, 'apps/api/src', name), 'utf8');
    assert.match(source, /http\/request-values/, `${name} must use the shared API error builder`);
    assert.doesNotMatch(source, /function\s+apiError\b/, `${name} must not duplicate apiError`);
  }
});

test('top-level HTTP app remains an assembly root instead of absorbing account and administration routes', () => {
  const source = readFileSync(resolve(root, 'apps/api/src/app.ts'), 'utf8');
  assert.match(source, /publicAuthenticationApp/);
  assert.match(source, /accountApp/);
  assert.match(source, /administrationApp/);
  assert.doesNotMatch(source, /Sql(?:Credential|Member|SystemConfig)Repository/, 'app.ts must not absorb account or administration repositories');
  assert.doesNotMatch(source, /app\.(?:get|post|put|patch|delete)\(['"]\/api\/(?:auth|me|members|settings|dictionaries|scopes)/, 'app.ts must not absorb account or administration routes');
});

test('demand import flows do not reach D1 directly', () => {
  const source = readFileSync(resolve(root, 'apps/api/src/demand-import.ts'), 'utf8');
  assert.doesNotMatch(source, /c\.env\.DB|\bD1(?:Database|PreparedStatement)\b/, 'demand import routes must use portable repositories instead of D1 APIs directly');
});

test('reserve planning flows do not reach D1 directly', () => {
  const source = readFileSync(resolve(root, 'apps/api/src/reserve-planning.ts'), 'utf8');
  assert.doesNotMatch(source, /c\.env\.DB|\bD1(?:Database|PreparedStatement)\b/, 'reserve planning routes must use portable repositories instead of D1 APIs directly');
});

test('finance flows do not reach D1 directly', () => {
  const source = readFileSync(resolve(root, 'apps/api/src/finance.ts'), 'utf8');
  assert.match(source, /SqlFinance(?:Budget|Entry|Query|Summary|Write)Repository/, 'finance routes must use portable finance repositories');
  assert.doesNotMatch(source, /c\.env\.DB|\bD1(?:Database|PreparedStatement)\b/, 'finance routes must use portable repositories instead of D1 APIs directly');
});

test('legacy project lifecycle flows do not reach D1 directly', () => {
  const source = readFileSync(resolve(root, 'apps/api/src/project-lifecycle.ts'), 'utf8');
  assert.match(source, /SqlLegacyExecutionRepository/, 'legacy project lifecycle flows must use the portable compatibility repository');
  assert.doesNotMatch(source, /c\.env\.DB|\bD1(?:Database|PreparedStatement)\b|\.prepare\(/, 'project lifecycle routes must use portable repositories instead of D1 APIs directly');
});

test('analysis and notification flows stay isolated and do not reach Cloudflare persistence directly', () => {
  const analysis = readFileSync(resolve(root, 'apps/api/src/analysis-operations.ts'), 'utf8');
  const notifications = readFileSync(resolve(root, 'apps/api/src/notification-operations.ts'), 'utf8');
  assert.match(analysis, /SqlAnalysisRepository/, 'analysis flows must use AnalysisRepository');
  assert.doesNotMatch(analysis, /SqlNotificationRepository|analysisOperationsApp\.(?:get|post|put|patch|delete)\(['"]\/(?:notification-|alerts)/, 'analysis routes must not absorb notification and alert operations');
  assert.match(notifications, /SqlNotificationRepository/, 'notification flows must use NotificationRepository');
  assert.doesNotMatch(notifications, /SqlBackupRepository|\/backups|\/system\/tasks/, 'notification routes must not absorb backup or scheduled-task operations');
  for (const source of [analysis, notifications]) {
    assert.doesNotMatch(source, /c\.env\.DB|env\.DB|env\.FILES|\bD1(?:Database|PreparedStatement)\b|\.prepare\(/, 'analysis and notification routes must use portable persistence ports instead of Cloudflare bindings directly');
  }
});

test('backup and scheduled-task flows stay isolated from analysis routes and Cloudflare bindings', () => {
  const analysis = readFileSync(resolve(root, 'apps/api/src/analysis-operations.ts'), 'utf8');
  const backups = readFileSync(resolve(root, 'apps/api/src/backup-operations.ts'), 'utf8');
  const tasks = readFileSync(resolve(root, 'apps/api/src/system-tasks.ts'), 'utf8');
  assert.doesNotMatch(analysis, /SqlBackupRepository|analysisOperationsApp\.(?:get|post|put|patch|delete)\(['"]\/(?:backups|system\/tasks)/, 'analysis routes must not absorb backup or scheduled-task operations');
  assert.match(backups, /SqlBackupRepository/, 'backup flows must use BackupRepository');
  assert.match(backups, /backupOperationsApp\.(?:get|post)\(['"]\/backups/, 'backup HTTP routes must live in backup-operations.ts');
  assert.doesNotMatch(backups, /\/notification-|\/alerts|\/system\/tasks/, 'backup routes must not absorb notifications, alerts, or scheduled-task HTTP routes');
  assert.match(tasks, /systemTasksApp\.post\(['"]\/system\/tasks\/run/, 'scheduled-task HTTP route must live in system-tasks.ts');
  assert.doesNotMatch(tasks, /SqlBackupRepository/, 'scheduled-task orchestration must call the backup module instead of reaching into backup persistence');
  for (const source of [backups, tasks]) {
    assert.doesNotMatch(source, /c\.env\.DB|env\.DB|env\.FILES|\bD1(?:Database|PreparedStatement)\b|\.prepare\(/, 'backup and scheduled-task modules must use portable persistence ports instead of Cloudflare bindings directly');
  }
});

test('project execution flows do not reach D1 directly', () => {
  const routeSources = ['project-execution.ts', 'project-execution-query.ts', 'project-delivery.ts', 'project-task-progress.ts'].map((name) => readFileSync(resolve(root, 'apps/api/src', name), 'utf8'));
  assert.match(routeSources.join('\n'), /Sql(?:ReserveProject|ProjectRelease|ProjectTask|TaskSupply|TaskImplementation|TaskSettlement|ExecutionQuery)Repository/, 'project execution routes must use portable business repositories');
  for (const source of routeSources) {
    assert.doesNotMatch(source, /c\.env\.DB|\bD1(?:Database|PreparedStatement)\b|\.prepare\(/, 'project execution routes must use portable repositories instead of D1 APIs directly');
  }
});

test('project execution aggregate query routes stay isolated from mutation routes', () => {
  const facade = readFileSync(resolve(root, 'apps/api/src/project-execution.ts'), 'utf8');
  const queries = readFileSync(resolve(root, 'apps/api/src/project-execution-query.ts'), 'utf8');
  assert.doesNotMatch(facade, /\/demands\/:id\/execution|\/projects\/:id\/execution/, 'mutation route module must not absorb aggregate execution queries again');
  assert.match(queries, /\/demands\/:id\/execution/);
  assert.match(queries, /\/projects\/:id\/execution/);
  assert.doesNotMatch(queries, /\.post\(|\.put\(|\.patch\(|\.delete\(/, 'aggregate execution query module must stay read-only');
});

test('task-stage progress mutations stay isolated from reserve and task-definition routes', () => {
  const execution = readFileSync(resolve(root, 'apps/api/src/project-execution.ts'), 'utf8');
  const progress = readFileSync(resolve(root, 'apps/api/src/project-task-progress.ts'), 'utf8');
  for (const path of ['/task-material-supply-events', '/task-implementations', '/task-settlements']) {
    assert.equal(execution.includes(path), false, `project-execution.ts must not absorb ${path} again`);
    assert.equal(progress.includes(path), true, `project-task-progress.ts must own ${path}`);
  }
  assert.doesNotMatch(progress, /\/reserve-projects|\/project-releases|\/project-tasks['"]/, 'task progress module must not absorb reserve, release, or task-definition routes');
});

test('project delivery routes stay isolated from reserve-project lifecycle routes', () => {
  const reserve = readFileSync(resolve(root, 'apps/api/src/project-execution.ts'), 'utf8');
  const delivery = readFileSync(resolve(root, 'apps/api/src/project-delivery.ts'), 'utf8');
  for (const path of ['/project-releases', '/project-tasks']) {
    assert.equal(reserve.includes(path), false, `project-execution.ts must not absorb ${path} again`);
    assert.equal(delivery.includes(path), true, `project-delivery.ts must own ${path}`);
  }
  assert.doesNotMatch(delivery, /\/reserve-projects/, 'delivery module must not absorb reserve-project lifecycle routes');
});

test('authentication middleware uses portable session and member repositories', () => {
  const source = readFileSync(resolve(root, 'apps/api/src/auth.ts'), 'utf8');
  assert.match(source, /SqlSessionRepository/);
  assert.match(source, /SqlMemberRepository/);
  assert.doesNotMatch(source, /c\.env\.DB|\bD1Database\b/, 'auth middleware must not depend directly on D1');
});

test('session lifecycle helpers use SessionRepository instead of auth_sessions SQL', () => {
  const source = readFileSync(resolve(root, 'apps/api/src/session.ts'), 'utf8');
  assert.match(source, /SqlSessionRepository/);
  assert.doesNotMatch(source, /\bD1Database\b|\b(?:FROM|INTO|UPDATE)\s+auth_sessions\b/i, 'session helpers must not inline auth session persistence');
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

test('Notion object storage adapter depends inward on the portable ObjectStorePort', () => {
  const file = resolve(root, 'apps/api/src/adapters/notion/notion-object-store.ts');
  assert.equal(existsSync(file), true, '缺少 Notion object-store adapter');
  const source = readFileSync(file, 'utf8');
  assert.match(source, /implements\s+ObjectStorePort/);
  assert.match(source, /ports\/object-store/);
  assert.doesNotMatch(source, /\bD1Database\b|\bR2Bucket\b/, 'Notion adapter must not bind directly to Cloudflare persistence types');
});

test('business batch import is never the only creation path for demand data', () => {
  const apiSource = readFileSync(resolve(root, 'apps/api/src/demand-import.ts'), 'utf8');
  const webSource = readFileSync(resolve(root, 'apps/web/src/views/DemandsView.vue'), 'utf8');
  assert.match(apiSource, /post\('\/imports'/, '需求存在批量导入时必须保留导入接口');
  assert.match(readFileSync(resolve(root, 'apps/api/src/structured-demand.ts'), 'utf8'), /post\('\/demands'/, '需求支持批量导入时必须同时支持服务端手工新增');
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

test('web decorative labels stay Chinese instead of reintroducing English chrome', () => {
  for (const file of collectSourceFiles(resolve(root, 'apps/web/src'))) {
    if (!file.endsWith('.vue')) continue;
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /class="page-eyebrow"[^>]*>\s*[A-Z][A-Z\s/&-]{2,}\s*</, `${file} 的页面眉标仍使用纯英文装饰文案`);
    assert.doesNotMatch(source, /(?:TRANSMISSION PROJECTS|SYSTEM SETUP|ACCOUNT SECURITY|ACCOUNT|SECURITY)/, `${file} 的认证界面仍使用纯英文装饰文案`);
    assert.doesNotMatch(source, /class="object-kicker"[^>]*>\s*PROJECT\b/, `${file} 的对象眉标仍使用英文 PROJECT`);
  }
});

test('primary workspaces provide an explicit retry action for load failures', () => {
  const retryContracts = [
    ['DashboardView.vue', 'loadDashboard'],
    ['DemandsView.vue', 'loadInitial'],
    ['FinanceView.vue', 'loadInitial'],
    ['AnalysisView.vue', 'refresh'],
    ['AdministrationView.vue', 'load'],
  ];
  for (const [name, handler] of retryContracts) {
    const source = readFileSync(resolve(root, 'apps/web/src/views', name), 'utf8');
    assert.match(source, new RegExp(`@click=["']${handler}["'][^>]*>\\s*重新加载`), `${name} 的加载失败提示缺少明确重新加载动作`);
  }
});

test('web business UI cannot render browser-native controls directly', () => {
  const pressableFile = resolve(root, 'apps/web/src/app/AppPressable.vue');
  const filePickerFile = resolve(root, 'apps/web/src/app/AppFilePicker.vue');
  const primitiveFiles = new Set([pressableFile, filePickerFile]);
  for (const file of collectSourceFiles(resolve(root, 'apps/web/src'))) {
    if (!file.endsWith('.vue') || primitiveFiles.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /<(?:button|input|select|textarea)\b/i, `${file} 直接渲染了浏览器原生表单控件；请使用设计系统组件`);
    assert.doesNotMatch(source, /\bh\(\s*['"](?:button|input|select|textarea)['"]/i, `${file} 动态渲染了浏览器原生表单控件；请使用设计系统组件`);
  }
  const pressable = readFileSync(pressableFile, 'utf8');
  assert.match(pressable, /appearance:\s*none/);
  assert.match(pressable, /border:\s*0/);
  assert.match(pressable, /background:\s*transparent/);
  const filePicker = readFileSync(filePickerFile, 'utf8');
  assert.match(filePicker, /class="native-file-input"/);
  assert.match(filePicker, /clip-path:\s*inset\(50%\)/);
});

test('task progress drawers cannot close while a save request is in flight', () => {
  for (const relative of [
    'apps/web/src/features/tasks/TaskImplementationDrawer.vue',
    'apps/web/src/features/tasks/TaskSettlementDrawer.vue',
  ]) {
    const source = readFileSync(resolve(root, relative), 'utf8');
    assert.match(source, /function setShow\(value: boolean\)/, `${relative} 必须统一守卫抽屉 show 变化`);
    assert.match(source, /:mask-closable="!saving"/, `${relative} 保存期间不得通过遮罩关闭`);
    assert.match(source, /:closable="!saving"/, `${relative} 保存期间不得通过右上角关闭`);
    assert.match(source, /@update:show="setShow"/, `${relative} 不得把 update:show 无条件透传给父组件`);
  }

  const taskDetail = readFileSync(resolve(root, 'apps/web/src/views/TaskDetailView.vue'), 'utf8');
  assert.match(taskDetail, /function setSupplyShow\(value: boolean\)/, '供应抽屉必须统一守卫 show 变化');
  assert.match(taskDetail, /:mask-closable="!savingSupply"/, '供应保存期间不得通过遮罩关闭');
  assert.match(taskDetail, /:closable="!savingSupply"/, '供应保存期间不得通过右上角关闭');
  assert.match(taskDetail, /@update:show="setSupplyShow"/, '供应抽屉不得把 update:show 直接写入状态');
});

test('primary write overlays cannot be dismissed while a mutation is in flight', () => {
  const projects = readFileSync(resolve(root, 'apps/web/src/views/ProjectsView.vue'), 'utf8');
  assert.match(projects, /function setCreateOpen\(value: boolean\)/, '项目新建抽屉必须守卫 show 变化');
  assert.match(projects, /:mask-closable="!creating"/);
  assert.match(projects, /:close-on-esc="!creating"/);
  assert.match(projects, /:closable="!creating"/);

  const demands = readFileSync(resolve(root, 'apps/web/src/views/DemandsView.vue'), 'utf8');
  assert.match(demands, /function setManualDemandOpen\(value: boolean\)/, '需求新建弹窗必须守卫 show 变化');
  assert.match(demands, /function setDemandDetailOpen\(value: boolean\)/, '需求详情写入期间必须守卫 show 变化');
  assert.match(demands, /:close-on-esc="!savingManualDemand"/);
  assert.match(demands, /:closable="!savingManualDemand"/);
  assert.match(demands, /:mask-closable="!savingDemandMaterial"/);
  assert.match(demands, /:close-on-esc="!savingDemandMaterial"/);
  assert.match(demands, /:closable="!savingDemandMaterial"/);

  const projectDetail = readFileSync(resolve(root, 'apps/web/src/views/ProjectDetailView.vue'), 'utf8');
  assert.match(projectDetail, /:close-on-esc="!reserveConfirming"/);
  assert.match(projectDetail, /:closable="!reserveConfirming"/);
  assert.match(projectDetail, /:close-on-esc="!releasing"/);
  assert.match(projectDetail, /:closable="!releasing"/);

  const administration = readFileSync(resolve(root, 'apps/web/src/views/AdministrationView.vue'), 'utf8');
  assert.ok((administration.match(/:close-on-esc="!saving"/g) ?? []).length >= 2, '成员编辑和重置密码都必须禁止保存中 Esc 关闭');
  assert.ok((administration.match(/:closable="!saving"/g) ?? []).length >= 2, '成员编辑和重置密码都必须禁止保存中右上角关闭');

  const masterData = readFileSync(resolve(root, 'apps/web/src/views/MasterDataView.vue'), 'utf8');
  assert.match(masterData, /const writeModalGuardProps = computed\(/, '基础台账写弹窗应共享同一保存期关闭门禁');
  assert.ok((masterData.match(/v-bind="writeModalGuardProps"/g) ?? []).length >= 14, '基础台账主要写弹窗必须统一应用关闭门禁');
});

test('inline finance and analysis editors lock business context during mutations', () => {
  const finance = readFileSync(resolve(root, 'apps/web/src/views/FinanceView.vue'), 'utf8');
  assert.match(finance, /data-test="finance-framework"[^>]*:disabled="saving"/, '资金写请求期间不得切换框架');
  assert.match(finance, /data-test="budget-project"[^>]*:disabled="saving"/, '预算写请求期间不得切换子项目');
  assert.match(finance, /data-test="entry-project"[^>]*:disabled="saving"/, '流水写请求期间不得切换子项目');
  assert.match(finance, /data-test="open-framework-form"[^>]*:disabled="saving"/, '框架保存期间不得收起/切换创建表单');
  assert.match(finance, /data-test="open-entry-form"[^>]*:disabled="saving"/, '流水保存期间不得收起登记表单');

  const analysis = readFileSync(resolve(root, 'apps/web/src/views/AnalysisView.vue'), 'utf8');
  assert.match(analysis, /data-test="analysis-as-of"[^>]*:disabled="saving"/, '分析写请求期间不得切换统计日期');
  assert.match(analysis, /data-test="analysis-framework"[^>]*:disabled="saving"/, '分析写请求期间不得切换框架');
  assert.match(analysis, /data-test="plan-project"[^>]*:disabled="saving"/, '月计划保存期间不得切换项目');
  assert.match(analysis, /data-test="plan-amount"[^>]*:disabled="saving"/, '月计划保存期间不得改写当前提交金额');
  assert.match(analysis, /async function setMilestoneStatus[^]*?if \(saving\.value\) return;[^]*?saving\.value = true;[^]*?finally \{ saving\.value = false; \}/, '年度事项状态更新必须进入统一写锁');
  assert.match(analysis, /loading: saving\.value[^}]*disabled: saving\.value/, '桌面年度事项操作必须显示进行中并阻止重复提交');
  assert.match(analysis, /:loading="saving"[^>]*:disabled="saving"[^>]*@click="setMilestoneStatus/, '手机年度事项操作必须阻止重复提交');

  const demands = readFileSync(resolve(root, 'apps/web/src/views/DemandsView.vue'), 'utf8');
  assert.match(demands, /const mappingBusy = computed\(/, '需求导入应统一定义映射上下文忙状态');
  assert.match(demands, /if \(workspaceMutationBusy\.value\) return;/, '需求写入期间不得切换主工作区 Tab');
  assert.match(demands, /data-test="mapping-template"[^>]*:disabled="mappingBusy"/, '模板保存或导入期间不得切换映射模板');
  assert.match(demands, /mapping-source-\$\{field\.key\}`[^>]*:disabled="mappingBusy"/, '模板保存或导入期间不得修改字段映射');
  assert.match(demands, /data-test="add-material"[^>]*:disabled="savingMaterial"/, '标准物资保存期间不得收起编辑区');
  assert.match(demands, /data-test="material-name"[^>]*:disabled="savingMaterial"/, '标准物资保存期间不得改写名称');
});

test('mobile UI keeps usable navigation and dashboard density', () => {
  const appSource = readFileSync(resolve(root, 'apps/web/src/App.vue'), 'utf8');
  const dashboardSource = readFileSync(resolve(root, 'apps/web/src/views/DashboardView.vue'), 'utf8');
  const styleSource = readFileSync(resolve(root, 'apps/web/src/styles.css'), 'utf8');
  assert.match(appSource, /mobile-bottom-nav/);
  assert.match(appSource, /n-drawer/);
  assert.match(styleSource, /@media \(max-width: (?:7\d\d|6\d\d)px\)/);
  assert.match(styleSource, /\.mobile-bottom-nav/);
  assert.match(styleSource, /\.app-sider\s*\{\s*display:\s*none/);
  assert.match(styleSource, /env\(safe-area-inset-bottom\)/);
  assert.match(dashboardSource, /overview-strip/);
  assert.match(dashboardSource, /grid-template-columns:\s*1fr 1fr/);
  assert.doesNotMatch(dashboardSource, /:cols="5"/);
});

test('compact desktop navigation keeps visible text labels instead of becoming an icon-only rail', () => {
  const styleSource = readFileSync(resolve(root, 'apps/web/src/styles.css'), 'utf8');
  const compactStart = styleSource.indexOf('@media (max-width: 1100px) and (min-width: 768px)');
  const mobileStart = styleSource.indexOf('@media (max-width: 767px)');
  assert.ok(compactStart >= 0 && mobileStart > compactStart, 'missing compact desktop navigation breakpoint');
  const compactSource = styleSource.slice(compactStart, mobileStart);
  assert.doesNotMatch(
    compactSource,
    /\.nav-item\s*>\s*span[^}]*display:\s*none/,
    'compact desktop navigation must keep business labels visible; icon-only navigation is not usable on touch laptops/tablets',
  );
  assert.match(compactSource, /\.nav-item[^}]*flex-direction:\s*column/);
});

test('pressable reset stays low-specificity so business layout styles cannot be silently overridden', () => {
  const pressable = readFileSync(resolve(root, 'apps/web/src/app/AppPressable.vue'), 'utf8');
  assert.match(
    pressable,
    /:where\(\.app-pressable\)\s*\{/,
    'AppPressable 的基础 reset 必须使用 :where() 降低优先级，业务 padding/圆角/背景不得再被组件 reset 吃掉',
  );
  assert.doesNotMatch(
    pressable,
    /\n\.app-pressable\s*\{/,
    '禁止恢复高优先级 .app-pressable 基础 reset；这会重新制造侧栏/卡片布局覆盖问题',
  );
});

test('application shell uses username as the primary identity and role only as secondary metadata', () => {
  const appSource = readFileSync(resolve(root, 'apps/web/src/App.vue'), 'utf8');
  const identityCopy = appSource.match(/<div class="identity-copy">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.match(appSource, /account-avatar">\{\{\s*currentUser\.username\.slice\(0,\s*1\)/, '账号头像必须来自 username，而不是显示名/角色');
  assert.match(appSource, /account-copy"><strong>\{\{\s*currentUser\.username\s*\}\}<\/strong><small>\{\{\s*roleLabels\[currentUser\.role\]\s*\}\}/, '侧栏账号卡必须“用户名主、角色次”');
  assert.match(identityCopy, /<strong>\{\{\s*currentUser\.username\s*\}\}<\/strong>/, '右上角必须以 username 作为当前身份');
  assert.doesNotMatch(identityCopy, /roleLabels\[currentUser\.role\]/, '右上角不得再次重复角色');
});

test('mobile primary navigation keeps the demand to project to task workflow at the first level', () => {
  const appSource = readFileSync(resolve(root, 'apps/web/src/App.vue'), 'utf8');
  const styleSource = readFileSync(resolve(root, 'apps/web/src/styles.css'), 'utf8');
  const mobileNav = appSource.match(/<nav class="mobile-bottom-nav"[\s\S]*?<\/nav>/)?.[0] ?? '';
  assert.match(mobileNav, /navigateMobile\('\/demands'\)/, '需求必须是手机一级导航，而不是藏在“更多”里');
  assert.match(mobileNav, /navigateMobile\('\/projects'\)/);
  assert.match(mobileNav, /navigateMobile\('\/tasks'\)/);
  assert.match(styleSource, /\.mobile-bottom-nav[\s\S]*grid-template-columns:\s*repeat\(5,\s*1fr\)/);
});

test('web business typography never drops below the 12px readability floor', () => {
  for (const file of collectSourceFiles(resolve(root, 'apps/web/src'))) {
    if (!file.endsWith('.vue') && !file.endsWith('.css')) continue;
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /font-size:\s*(?:10|11)px\b/,
      `${file} 仍包含低于 12px 的业务界面文字；辅助信息也必须保持可读`,
    );
  }
});

test('business UI does not use tiny action buttons', () => {
  const webRoot = resolve(root, 'apps/web/src');
  const tinyButtons = collectSourceFiles(webRoot)
    .filter((path) => path.endsWith('.vue'))
    .filter((path) => {
      const source = readFileSync(path, 'utf8');
      return source.includes('size="tiny"') || source.includes("size='tiny'");
    });
  assert.deepEqual(tinyButtons, [], `业务操作禁止使用 tiny 按钮：${tinyButtons.join(', ')}`);
});

test('light-theme text tokens keep readable contrast on common surfaces', () => {
  const source = readFileSync(resolve(root, 'apps/web/src/styles.css'), 'utf8');
  const rootBlock = source.match(/:root\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const token = (name) => rootBlock.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  const tertiary = token('ui-text-tertiary');
  const surfaces = ['ui-surface', 'ui-canvas', 'ui-surface-muted'].map((name) => [name, token(name)]);
  assert.ok(tertiary, '缺少 --ui-text-tertiary');
  for (const [name, background] of surfaces) {
    assert.ok(background, `缺少 --${name}`);
    const ratio = contrastRatio(tertiary, background);
    assert.ok(ratio >= 4.5, `浅色主题 --ui-text-tertiary 对 --${name} 的对比度仅 ${ratio.toFixed(2)}:1，12–13px 业务文字不可读`);
  }
});

test('error recovery actions use real buttons instead of collapsed text-only hit targets', () => {
  for (const file of collectSourceFiles(resolve(root, 'apps/web/src'))) {
    if (!file.endsWith('.vue')) continue;
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /<n-button[^>]*\btext\b[^>]*>\s*重新加载\s*<\/n-button>/,
      `${file} 的“重新加载”不得使用 text-only 按钮；错误恢复动作必须保留真实可点击高度`,
    );
  }
});

test('line deletion has a non-hover detail action for touch desktop users', () => {
  const source = readFileSync(resolve(root, 'apps/web/src/views/MasterDataView.vue'), 'utf8');
  const options = source.match(/const lineMoreOptions = \[[\s\S]*?\];/)?.[0] ?? '';
  const handler = source.match(/function handleLineMoreAction\(key: string\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(options, /label:\s*'删除线路'[^}]*key:\s*'delete'/, '线路详情“更多操作”必须提供删除入口，不能只依赖 hover 快捷操作');
  assert.match(handler, /key === 'delete'[\s\S]*requestDelete\('lines'/, '详情删除入口必须走既有线路删除确认流程');
});

test('drawer responsive selectors target the NDrawer root instead of a nonexistent descendant', () => {
  for (const file of collectSourceFiles(resolve(root, 'apps/web/src'))) {
    if (!file.endsWith('.vue') && !file.endsWith('.css')) continue;
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /:global\(\.[\w-]*drawer\s+\.n-drawer\)/,
      `${file} 将 drawer class 直接挂在 NDrawer 根节点时，不得再用后代选择器匹配 .n-drawer`,
    );
  }
});

test('text-style return navigation keeps a usable touch target', () => {
  const styleSource = readFileSync(resolve(root, 'apps/web/src/styles.css'), 'utf8');
  assert.match(styleSource, /\.breadcrumb-back,\s*\.back-button\s*\{[^}]*min-height:\s*36px/);
  const mobile = styleSource.match(/@media \(max-width:\s*767px\)[\s\S]*$/)?.[0] ?? '';
  assert.match(mobile, /\.breadcrumb-back,\s*\.back-button\s*\{[^}]*min-height:\s*44px/, '手机返回导航命中高度不得低于 44px');
});

test('async workspace context loaders ignore stale responses', () => {
  const finance = readFileSync(resolve(root, 'apps/web/src/views/FinanceView.vue'), 'utf8');
  assert.match(finance, /let frameworkContextSequence = 0;/, '资金框架上下文必须有请求序号');
  assert.match(finance, /sequence !== frameworkContextSequence \|\| selectedFrameworkId\.value !== frameworkId/, '旧框架响应不得覆盖当前框架');
  assert.match(finance, /let budgetProjectSequence = 0;/, '预算项目切换必须有请求序号');
  assert.match(finance, /sequence !== budgetProjectSequence \|\| selectedBudgetProjectId\.value !== projectId/, '旧预算项目响应不得覆盖当前项目');
  assert.match(finance, /contextSequence !== frameworkContextSequence[^]*?entryCursor\.value !== cursor/, '旧流水分页响应不得追加到新框架');

  const analysis = readFileSync(resolve(root, 'apps/web/src/views/AnalysisView.vue'), 'utf8');
  assert.match(analysis, /let frameworkContextSequence = 0;/, '分析框架上下文必须有请求序号');
  assert.match(analysis, /sequence !== frameworkContextSequence \|\| selectedFrameworkId\.value !== frameworkId/, '旧分析框架响应不得覆盖当前框架');
  assert.match(analysis, /let milestoneRequestSequence = 0;/, '事项读取必须有统一请求序号');
  assert.match(analysis, /sequence !== milestoneRequestSequence \|\| asOfDate\.value !== requestedAsOf/, '旧统计日期事项响应不得覆盖当前日期');
  assert.match(analysis, /const milestonePromise = loadMilestones\(requestedAsOf\)/, '分析全量刷新也必须复用事项竞态门禁');
});

test('committed finance and analysis writes distinguish refresh failure from mutation failure', () => {
  const finance = readFileSync(resolve(root, 'apps/web/src/views/FinanceView.vue'), 'utf8');
  assert.match(finance, /async function refreshAfterCommittedWrite\(/, '资金页必须统一处理已提交后的刷新失败');
  for (const message of ['框架已创建', '执行协议已创建', '项目框架归属已更新', '预算草稿已保存', '预算已确认；不会自动生成预算发生流水', '资金流水已登记']) {
    assert.match(finance, new RegExp(`refreshAfterCommittedWrite\\('${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `资金写入“${message}”必须区分提交失败与刷新失败`);
  }
  assert.match(finance, /最新数据刷新失败，请重新加载/, '资金页刷新失败必须明确说明写入已成功并提供恢复指引');

  const analysis = readFileSync(resolve(root, 'apps/web/src/views/AnalysisView.vue'), 'utf8');
  assert.match(analysis, /async function refreshAfterCommittedWrite\(/, '分析页必须统一处理已提交后的刷新失败');
  for (const message of ['月计划已保存', '分析规则已更新', '月报修订已生成', '年度事项已创建', '事项状态已更新']) {
    assert.match(analysis, new RegExp(`refreshAfterCommittedWrite\\('${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `分析写入“${message}”必须区分提交失败与刷新失败`);
  }
  assert.match(analysis, /最新数据刷新失败，请重新加载/, '分析页刷新失败必须明确说明写入已成功并提供恢复指引');
});

test('committed demand writes distinguish refresh failure from mutation failure', () => {
  const demands = readFileSync(resolve(root, 'apps/web/src/views/DemandsView.vue'), 'utf8');
  assert.match(demands, /async function refreshAfterCommittedWrite\(/, '需求页必须统一处理已提交后的刷新失败');
  for (const message of ['需求已创建', '需求物资子明细已添加', '标准物资已添加']) {
    assert.match(demands, new RegExp(`refreshAfterCommittedWrite\\('${message}'`), `需求写入“${message}”必须区分提交失败与刷新失败`);
  }
  assert.match(demands, /refreshAfterCommittedWrite\(`导入完成，已发布 \$\{publishedRows\} 行需求`/, '导入发布完成后的需求池刷新失败不得反向标记导入失败');
  assert.match(demands, /最新数据刷新失败，请重新加载/, '需求页刷新失败必须明确说明写入已成功并提供恢复指引');
});

test('committed master-data writes distinguish refresh failure from mutation failure', () => {
  const masterData = readFileSync(resolve(root, 'apps/web/src/views/MasterDataView.vue'), 'utf8');
  assert.match(masterData, /async function refreshAfterCommittedWrite\(/, '基础台账必须统一处理已提交后的刷新失败');
  for (const message of [
    '已删除未引用的台账对象',
    '电压等级已保存',
    '班组配置已保存',
    '杆塔类型已保存',
    '自定义字段已保存',
    '物理杆塔属性已保存',
    '物理杆塔自定义字段已保存',
  ]) {
    assert.match(masterData, new RegExp(`refreshAfterCommittedWrite\\('${message}'`), `基础台账写入“${message}”必须区分提交失败与刷新失败`);
  }
  assert.match(masterData, /committedRefreshRetry/, '基础台账写后刷新失败必须保留原刷新动作供页面内重试');
  assert.match(masterData, /async function retryMasterData\(/, '基础台账重新加载必须能恢复最近一次已提交写入的刷新');
  assert.match(masterData, /最新数据刷新失败，请重新加载/, '基础台账刷新失败必须明确说明写入已成功并提供恢复指引');
});

test('committed system-operation writes distinguish refresh failure from mutation failure', () => {
  const operations = readFileSync(resolve(root, 'apps/web/src/features/settings/SystemOperationsPanel.vue'), 'utf8');
  assert.match(operations, /async function refreshAfterCommittedWrite\(/, '通知与备份写入必须统一处理已提交后的刷新失败');
  for (const message of ['通知地址已保存', '备份任务已创建', '备份任务已推进', '完整性校验完成']) {
    assert.match(operations, new RegExp(`refreshAfterCommittedWrite\\('${message}'`), `通知与备份写入“${message}”必须区分提交失败与刷新失败`);
  }
  assert.match(operations, /最新数据刷新失败，请重新加载/, '通知与备份刷新失败必须明确说明写入已成功并提供恢复指引');
});

test('local API development rebuilds the local D1 when the single development baseline changes', () => {
  const apiPackage = JSON.parse(readFileSync(resolve(root, 'apps/api/package.json'), 'utf8'));
  assert.equal(apiPackage.scripts.dev, 'node ../../scripts/dev/api-dev.mjs');
  const source = readFileSync(resolve(root, 'scripts/dev/api-dev.mjs'), 'utf8');
  const localWrangler = readFileSync(resolve(root, 'apps/api/wrangler.jsonc'), 'utf8');
  assert.match(source, /0001_initial_schema|baseline|基线/);
  assert.match(source, /重建本地 D1/);
  assert.match(source, /'d1',\s*'migrations',\s*'apply'/);
  assert.match(source, /--env-file/);
  assert.match(source, /resolve\(root, '\.env'\)/);
  assert.match(localWrangler, /"required"\s*:\s*\["AUTH_CREDENTIAL_PEPPER",\s*"BOOTSTRAP_TOKEN"\]/);
  assert.doesNotMatch(source, /watch\(/);
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

test('CI keeps isolated headless browser acceptance as its own job', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts?.['test:ui:headless'], 'npm run build:web && playwright test --config playwright.config.ts');
  assert.match(workflow, /^\s{2}headless-ui:\s*$/m, 'CI must keep a dedicated headless-ui job');
  assert.match(workflow, /playwright install --with-deps chromium/, 'CI headless-ui job must install Chromium and its Linux dependencies');
  assert.match(workflow, /npm run test:ui:headless/, 'CI headless-ui job must execute the repository E2E command');
});

test('full local test gate reuses the web build produced by check', () => {
  const makefile = readFileSync(resolve(root, 'Makefile'), 'utf8');
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts?.['test:ui:headless:prepared'],
    'playwright test --config playwright.config.ts',
    'prepared headless test must run Playwright without rebuilding Web',
  );
  assert.match(makefile, /^test:\s+check\s*$/m, 'make test must finish check before UI E2E');
  assert.match(makefile, /^\s+npm run test:ui:headless:prepared\s*$/m, 'make test must reuse the Web build produced by check');
  assert.match(makefile, /^test-ui:\s*\n\s+npm run test:ui:headless\s*$/m, 'standalone make test-ui must remain self-contained and build Web first');
});

test('Makefile is the single ergonomic entry point without bypassing production governance', () => {
  const makefilePath = resolve(root, 'Makefile');
  assert.equal(existsSync(makefilePath), true, '仓库根目录必须提供 Makefile 作为统一工程入口');
  const source = readFileSync(makefilePath, 'utf8');
  for (const target of ['help', 'install', 'dev', 'test', 'check', 'test-ui', 'build', 'ci', 'production-preflight', 'production', 'production-smoke', 'production-inventory']) {
    assert.match(source, new RegExp(`^${target}:`, 'm'), `Makefile 缺少 ${target} target`);
  }
  assert.match(source, /npm run dev\b/, 'make dev 必须复用仓库正式本地启动入口');
  assert.match(source, /npm run check\b/, 'Makefile 必须保留完整 npm check 门禁');
  assert.match(source, /npm run test:ui:headless\b/, 'Makefile 必须暴露无头浏览器 UI 验收');
  assert.match(source, /scripts\/engineering\/github-workflow\.mjs production-promote\.yml --ref main --require-main-sync/, '生产一键发布必须走受保护的 Production promote workflow');
  assert.match(source, /scripts\/production\/public-smoke\.mjs --config apps\/api\/wrangler\.production\.jsonc/, 'Makefile 必须提供基于受控 production config 的只读公网 smoke');
  assert.doesNotMatch(source, /wrangler\s+deploy/, 'Makefile 不得直接执行 wrangler deploy 绕过生产治理');
  assert.doesNotMatch(source, /git\s+(?:reset|clean)\b/, 'Makefile 不得提供破坏工作区的 reset/clean 快捷入口');
});

test('engineering audit uses tracked source and the official npm advisory service', () => {
  const makefile = readFileSync(resolve(root, 'Makefile'), 'utf8');
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.match(makefile, /^audit:/m, 'Makefile 必须提供统一工程审计入口');
  assert.match(makefile, /^security-audit:/m, 'Makefile 必须提供独立依赖安全审计入口');
  assert.match(makefile, /npm run engineering:audit\b/, '工程审计应复用受版本控制的审计脚本');
  assert.match(makefile, /npm run security:audit\b/, '安全审计应复用固定 npm script');
  assert.equal(
    packageJson.scripts?.['security:audit'],
    'npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org',
    '安全审计必须显式使用 npm 官方 advisory API，不能受本机安装镜像能力影响',
  );
  assert.equal(
    packageJson.scripts?.['engineering:audit'],
    'node scripts/engineering/repository-audit.mjs',
    '工程审计必须使用仓库内可复现脚本',
  );
});

test('shared public contracts stay split by business domain behind a small barrel', () => {
  const sharedDir = resolve(root, 'packages/shared/src');
  const expectedModules = [
    'api.ts',
    'account.ts',
    'imports.ts',
    'master-data.ts',
    'project-execution.ts',
    'reserve-planning.ts',
    'finance.ts',
    'analysis.ts',
    'legacy-lifecycle.ts',
  ];
  for (const file of expectedModules) {
    assert.equal(existsSync(resolve(sharedDir, file)), true, `shared contract module missing: ${file}`);
  }
  const indexSource = readFileSync(resolve(sharedDir, 'index.ts'), 'utf8');
  const meaningfulLines = indexSource.split('\n').filter((line) => line.trim() && !line.trim().startsWith('//'));
  assert.ok(meaningfulLines.length <= expectedModules.length + 2, 'shared index.ts must remain a small re-export barrel');
  assert.doesNotMatch(indexSource, /\binterface\b|\bconst\s+MEMBER_ROLES\b|function\s+normalizeTowerNo/, 'shared declarations must live in domain modules, not the barrel');

  for (const file of ['index.ts', ...expectedModules]) {
    const source = readFileSync(resolve(sharedDir, file), 'utf8');
    for (const match of source.matchAll(/(?:from|export\s+\*)\s+['"](\.[^'"]+)['"]/g)) {
      assert.match(match[1], /\.ts$/, `${file} relative ESM specifier must include .ts so Node runtime can resolve source directly`);
    }
  }
  const baseTsconfig = readFileSync(resolve(root, 'tsconfig.base.json'), 'utf8');
  assert.match(baseTsconfig, /"allowImportingTsExtensions"\s*:\s*true/, 'TypeScript must allow explicit .ts ESM specifiers used by the Node runtime');
});

test('API object pagination cursors share one Base64URL JSON codec', () => {
  const cursorCodec = resolve(root, 'apps/api/src/http/cursor.ts');
  assert.equal(existsSync(cursorCodec), true, 'missing shared API cursor codec');
  const codecSource = readFileSync(cursorCodec, 'utf8');
  assert.match(codecSource, /export function encodeJsonCursor/);
  assert.match(codecSource, /export function decodeJsonCursor/);

  for (const relative of [
    'apps/api/src/demand-import.ts',
    'apps/api/src/finance.ts',
    'apps/api/src/project-execution.ts',
    'apps/api/src/project-execution-query.ts',
    'apps/api/src/reserve-planning.ts',
    'apps/api/src/transmission-grid.ts',
  ]) {
    const source = readFileSync(resolve(root, relative), 'utf8');
    assert.match(source, /\.\/http\/cursor\.ts/, `${relative} must use the shared cursor codec`);
    assert.doesNotMatch(source, /btoa\(JSON\.stringify|JSON\.parse\(atob/, `${relative} must not reimplement cursor Base64URL JSON`);
  }
});

test('expectedVersion request parsing stays centralized without merging route error contracts', () => {
  const requestValues = readFileSync(resolve(root, 'apps/api/src/http/request-values.ts'), 'utf8');
  assert.match(requestValues, /export function positiveIntegerValue/);
  assert.match(requestValues, /export function coercedPositiveIntegerValue/);

  for (const relative of [
    'apps/api/src/analysis-operations.ts',
    'apps/api/src/demand-import.ts',
    'apps/api/src/finance.ts',
    'apps/api/src/project-execution-shared.ts',
    'apps/api/src/project-lifecycle.ts',
    'apps/api/src/reserve-category-config.ts',
    'apps/api/src/reserve-planning.ts',
  ]) {
    const source = readFileSync(resolve(root, relative), 'utf8');
    assert.match(source, /\.\/http\/request-values\.ts/, `${relative} must use shared request value parsing`);
    assert.doesNotMatch(source, /function\s+(?:parseExpectedVersion|expectedVersion)\s*\(/, `${relative} must not reimplement expectedVersion parsing`);
    assert.doesNotMatch(source, /Number\.isSafeInteger\(value\)\s*&&\s*value\s*>=\s*1/, `${relative} must not copy the strict positive-version parser`);
    assert.doesNotMatch(source, /const\s+version\s*=\s*Number\(value\)[\s\S]{0,120}version\s*>=\s*1/, `${relative} must not copy the coercing positive-version parser`);
  }
});

test('reserve category configuration stays isolated from project reserve planning routes', () => {
  const planning = readFileSync(resolve(root, 'apps/api/src/reserve-planning.ts'), 'utf8');
  const categoryConfig = readFileSync(resolve(root, 'apps/api/src/reserve-category-config.ts'), 'utf8');
  const app = readFileSync(resolve(root, 'apps/api/src/app.ts'), 'utf8');

  assert.doesNotMatch(planning, /['"]\/reserve-categories['"]/);
  assert.doesNotMatch(planning, /['"]\/category-mappings/);
  assert.match(categoryConfig, /['"]\/reserve-categories['"]/);
  assert.match(categoryConfig, /['"]\/category-mappings/);
  assert.match(app, /app\.route\('\/api', reserveCategoryConfigApp\)/);
});

test('Node runtime gate exercises the real app, SQLite, Filesystem, and the single schema baseline', () => {
  const nodeConfig = readFileSync(resolve(root, 'apps/api/tsconfig.node-runtime.json'), 'utf8');
  assert.match(nodeConfig, /"src\/app\.ts"/, 'Node typecheck must include the real HTTP app');
  assert.doesNotMatch(nodeConfig, /adapters\/cloudflare|runtime\/cloudflare|src\/index\.ts/, 'Node typecheck must stay outside Cloudflare infrastructure');

  const appTest = resolve(root, 'tests/node-runtime-app.test.mjs');
  const migrationTest = resolve(root, 'tests/migrations.test.mjs');
  assert.equal(existsSync(appTest), true, 'missing Node application runtime E2E');
  assert.equal(existsSync(migrationTest), true, 'missing single-baseline schema test');
  const appSource = readFileSync(appTest, 'utf8');
  assert.match(appSource, /createNodePersistence/);
  assert.match(appSource, /PERSISTENCE/);
  assert.doesNotMatch(appSource, /\bDB\s*:|\bFILES\s*:/, 'Node E2E must not fall back to Cloudflare bindings');
  const migrationSource = readFileSync(migrationTest, 'utf8');
  assert.match(migrationSource, /0001_initial_schema\.sql/);
  assert.doesNotMatch(migrationSource, /0002_|0012_/);
});

test('Node integration suite is safe for file-level parallelism', () => {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const match = packageJson.scripts?.['test:node']?.match(/--test-concurrency=(\d+)/);
  assert.ok(match, 'test:node must declare explicit file-level concurrency');
  assert.ok(Number(match[1]) >= 5, 'test:node should run at least five test files in parallel');

  const wranglerHelper = readFileSync(resolve(root, 'tests/helpers/wrangler.mjs'), 'utf8');
  assert.match(wranglerHelper, /'--inspector-port'/, 'parallel Wrangler runtimes need isolated inspector ports');

  const migrationTests = readFileSync(resolve(root, 'tests/migrations.test.mjs'), 'utf8');
  assert.match(migrationTests, /node:sqlite/, 'single-baseline schema tests should validate SQLite directly');
  assert.match(migrationTests, /applyLocalMigrations/, 'schema tests must retain a real Wrangler migration smoke path');

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
