import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { watch, existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { readMigrationSnapshot, stageSnapshot, snapshotSignature } from './migration-snapshot.mjs';
import { createOutputCapture } from './process-output.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const apiDir = resolve(root, 'apps/api');
const migrationsDir = resolve(apiDir, 'migrations');
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const wranglerPackage = require('wrangler/package.json');
const wranglerCli = resolve(dirname(require.resolve('wrangler/package.json')), wranglerPackage.bin.wrangler);
const childEnv = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };

function runWrangler(args, { inherit = true } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [wranglerCli, ...args], {
      cwd: apiDir,
      env: childEnv,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    const capture = inherit ? null : createOutputCapture();
    if (capture) {
      child.stdout?.on('data', (chunk) => { capture.appendStdout(chunk); });
      child.stderr?.on('data', (chunk) => { capture.appendStderr(chunk); });
    }
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun(capture?.stdout() ?? '');
      else rejectRun(new Error(`wrangler ${args.join(' ')} 失败（code=${code ?? 'null'}, signal=${signal ?? 'none'}）\n${capture?.diagnostic() ?? ''}`));
    });
  });
}

const lockPath = resolve(root, 'tests/migrations.lock.json');
const stateDir = resolve(apiDir, '.wrangler/state');
const ledgerPath = resolve(apiDir, '.wrangler/migration-checksums.json');
let applied = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {};
function saveLedger() {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(`${ledgerPath}.tmp`, JSON.stringify(applied, null, 2));
  renameSync(`${ledgerPath}.tmp`, ledgerPath);
}
async function appliedNames() {
  try {
    const result = await runWrangler(['d1', 'execute', 'transmission-project-manager-local', '--local', '--persist-to', stateDir, '--command', 'SELECT name FROM d1_migrations ORDER BY id', '--json'], { inherit: false });
    return JSON.parse(result).flatMap((item) => item.results ?? []).map((row) => row.name);
  } catch (cause) {
    if (String(cause).includes('no such table: d1_migrations')) return [];
    throw cause;
  }
}
async function applyMigrations() {
  const first = readMigrationSnapshot({ migrationsDir, lockPath, applied });
  await delay(1000);
  const snapshot = readMigrationSnapshot({ migrationsDir, lockPath, applied });
  if (snapshotSignature(first) !== snapshotSignature(snapshot)) throw new Error('MIGRATION_NOT_READY: 等待完整文件和 checksum lock 稳定。');
  const names = await appliedNames();
  // On first use adopt the checked-in lock for migrations applied by the old launcher.
  for (const name of names) {
    const file = snapshot.find((item) => item.name === name);
    if (!file || (applied[name] && applied[name] !== file.hash)) throw new Error(`APPLIED_MIGRATION_CHANGED: ${name}`);
    applied[name] = file.hash;
  }
  saveLedger();
  const stageDir = mkdtempSync(resolve(tmpdir(), 'tpm-dev-migrations-'));
  try {
    stageSnapshot(snapshot, resolve(stageDir, 'migrations'));
    const configPath = resolve(stageDir, 'wrangler.json');
    // A D1-only config keeps the existing local binding/state while applying frozen bytes.
    writeFileSync(configPath, JSON.stringify({ name: 'transmission-project-manager-local', compatibility_date: '2026-09-12', d1_databases: [{ binding: 'DB', database_name: 'transmission-project-manager-local', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: resolve(stageDir, 'migrations') }] }));
    try {
      await runWrangler(['d1', 'migrations', 'apply', 'transmission-project-manager-local', '--local', '--persist-to', stateDir, '--config', configPath]);
    } finally {
      // Remember even a successfully applied prefix if a later migration failed.
      for (const name of await appliedNames()) {
        const file = snapshot.find((item) => item.name === name);
        if (file) applied[name] = file.hash;
      }
      saveLedger();
    }
    readMigrationSnapshot({ migrationsDir, lockPath, applied });
  } finally { rmSync(stageDir, { recursive: true, force: true }); }
}

console.log('[dev-db] 启动前检查并应用本地 D1 migration…');
await applyMigrations();
console.log('[dev-db] 本地 D1 schema 已就绪。');

const worker = spawn(process.execPath, [
  wranglerCli,
  'dev', '--local', '--ip', '127.0.0.1', '--port', '8787',
], {
  cwd: apiDir,
  env: childEnv,
  stdio: 'inherit',
});

let debounceTimer = null;
let applying = false;
let rerunRequested = false;

async function applyChangedMigrations() {
  if (applying) {
    rerunRequested = true;
    return;
  }
  applying = true;
  do {
    rerunRequested = false;
    try {
      console.log('[dev-db] 检测到 migration 变化，正在同步本地 D1…');
      await applyMigrations();
      console.log('[dev-db] migration 同步完成。');
    } catch (error) {
      console.error('[dev-db] migration 未执行或同步失败。');
      if (String(error).includes('APPLIED_MIGRATION_CHANGED')) { worker.kill('SIGTERM'); process.exitCode = 1; }
      console.error(error instanceof Error ? error.message : error);
    }
  } while (rerunRequested);
  applying = false;
}

function scheduleMigrationCheck() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { void applyChangedMigrations(); }, 1000);
}
const watcher = watch(migrationsDir, { persistent: true }, (_eventType, fileName) => {
  if (fileName?.endsWith('.sql')) scheduleMigrationCheck();
});
const lockWatcher = watch(dirname(lockPath), { persistent: true }, (_eventType, fileName) => {
  if (fileName === 'migrations.lock.json') scheduleMigrationCheck();
});

function shutdown(signal) {
  watcher.close();
  lockWatcher.close();
  if (debounceTimer) clearTimeout(debounceTimer);
  if (worker.exitCode === null) worker.kill(signal);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
worker.once('exit', (code, signal) => {
  watcher.close();
  lockWatcher.close();
  if (debounceTimer) clearTimeout(debounceTimer);
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = process.exitCode || code || 0;
});
