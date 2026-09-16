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
    assert.doesNotMatch(source, /<span>\s*(?:TRANSMISSION PROJECTS|ACCOUNT SECURITY|SECURITY)\s*<\/span>/, `${file} 的认证界面仍使用纯英文装饰文案`);
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
