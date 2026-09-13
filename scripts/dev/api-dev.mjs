import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { watch } from 'node:fs';
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
    let output = '';
    if (!inherit) {
      child.stdout?.on('data', (chunk) => { output += chunk; });
      child.stderr?.on('data', (chunk) => { output += chunk; });
    }
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun(output);
      else rejectRun(new Error(`wrangler ${args.join(' ')} 失败（code=${code ?? 'null'}, signal=${signal ?? 'none'}）\n${output}`));
    });
  });
}

async function applyMigrations() {
  await runWrangler([
    'd1', 'migrations', 'apply', 'transmission-project-manager-local', '--local',
  ]);
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
      console.error('[dev-db] migration 同步失败；业务 API 会由 schema readiness 门禁保持 fail-closed。');
      console.error(error instanceof Error ? error.message : error);
    }
  } while (rerunRequested);
  applying = false;
}

const watcher = watch(migrationsDir, { persistent: true }, (_eventType, fileName) => {
  if (!fileName?.endsWith('.sql')) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { void applyChangedMigrations(); }, 200);
});

function shutdown(signal) {
  watcher.close();
  if (debounceTimer) clearTimeout(debounceTimer);
  if (worker.exitCode === null) worker.kill(signal);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
worker.once('exit', (code, signal) => {
  watcher.close();
  if (debounceTimer) clearTimeout(debounceTimer);
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
