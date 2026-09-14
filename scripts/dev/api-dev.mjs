import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readMigrationSnapshot, stageSnapshot } from './migration-snapshot.mjs';
import { createOutputCapture } from './process-output.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const apiDir = resolve(root, 'apps/api');
const migrationsDir = resolve(apiDir, 'migrations');
const lockPath = resolve(root, 'tests/migrations.lock.json');
const stateDir = resolve(apiDir, '.wrangler/state');
const ledgerPath = resolve(apiDir, '.wrangler/development-schema-checksum.json');
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
      child.stdout?.on('data', (chunk) => capture.appendStdout(chunk));
      child.stderr?.on('data', (chunk) => capture.appendStderr(chunk));
    }
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun(capture?.stdout() ?? '');
      else rejectRun(new Error(`wrangler ${args.join(' ')} 失败（code=${code ?? 'null'}, signal=${signal ?? 'none'}）\n${capture?.diagnostic() ?? ''}`));
    });
  });
}

function readLedger() {
  if (!existsSync(ledgerPath)) return {};
  try { return JSON.parse(readFileSync(ledgerPath, 'utf8')); }
  catch { return {}; }
}

function saveLedger(value) {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(`${ledgerPath}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${ledgerPath}.tmp`, ledgerPath);
}

async function appliedNames() {
  try {
    const result = await runWrangler([
      'd1', 'execute', 'transmission-project-manager-local', '--local', '--persist-to', stateDir,
      '--command', 'SELECT name FROM d1_migrations ORDER BY id', '--json',
    ], { inherit: false });
    return JSON.parse(result).flatMap((item) => item.results ?? []).map((row) => row.name);
  } catch (cause) {
    if (String(cause).includes('no such table: d1_migrations')) return [];
    throw cause;
  }
}

async function ensureDevelopmentSchema() {
  const snapshot = readMigrationSnapshot({ migrationsDir, lockPath });
  const baseline = snapshot[0];
  const names = await appliedNames();
  const ledger = readLedger();
  const exactCurrentBaseline = names.length === 1 && names[0] === baseline.name && ledger[baseline.name] === baseline.hash;

  if (names.length > 0 && !exactCurrentBaseline) {
    console.log('[dev-db] 检测到开发 schema 基线变化或旧迁移历史，重建本地 D1；不创建新 migration 版本。');
    rmSync(stateDir, { recursive: true, force: true });
    saveLedger({});
  } else if (names.length === 0 && Object.keys(ledger).length > 0) {
    saveLedger({});
  }

  const stageDir = mkdtempSync(resolve(tmpdir(), 'tpm-dev-schema-'));
  try {
    stageSnapshot(snapshot, resolve(stageDir, 'migrations'));
    const configPath = resolve(stageDir, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify({
      name: 'transmission-project-manager-local',
      compatibility_date: '2026-09-12',
      d1_databases: [{
        binding: 'DB',
        database_name: 'transmission-project-manager-local',
        database_id: '00000000-0000-0000-0000-000000000000',
        migrations_dir: resolve(stageDir, 'migrations'),
      }],
    }));
    await runWrangler([
      'd1', 'migrations', 'apply', 'transmission-project-manager-local', '--local', '--persist-to', stateDir,
      '--config', configPath,
    ]);
    saveLedger({ [baseline.name]: baseline.hash });
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

console.log('[dev-db] 检查唯一开发 schema 基线…');
await ensureDevelopmentSchema();
console.log('[dev-db] 本地 D1 schema 已就绪。');

const worker = spawn(process.execPath, [
  wranglerCli,
  'dev', '--local', '--ip', '127.0.0.1', '--port', '8787',
], {
  cwd: apiDir,
  env: childEnv,
  stdio: 'inherit',
});

function shutdown(signal) {
  if (worker.exitCode === null) worker.kill(signal);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
worker.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code || 0;
});
