import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const wranglerPackage = require('wrangler/package.json');
export const wranglerCli = resolve(dirname(require.resolve('wrangler/package.json')), wranglerPackage.bin.wrangler);
export const apiDir = fileURLToPath(new URL('../../apps/api/', import.meta.url));

export function makeStateDir(prefix = 'tpm-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupStateDir(path) {
  rmSync(path, { recursive: true, force: true });
}

export function readLocalR2Object(stateDir, bucketName, key) {
  const metadataDir = join(stateDir, 'v3', 'r2', 'miniflare-R2BucketObject');
  for (const name of readdirSync(metadataDir).filter((entry) => entry.endsWith('.sqlite') && entry !== 'metadata.sqlite')) {
    const db = new DatabaseSync(join(metadataDir, name), { readOnly: true });
    try {
      const row = db.prepare('SELECT blob_id FROM _mf_objects WHERE key = ? LIMIT 1').get(key);
      if (row?.blob_id) return readFileSync(join(stateDir, 'v3', 'r2', bucketName, 'blobs', row.blob_id));
    } catch (error) {
      if (!String(error).includes('no such table: _mf_objects')) throw error;
    } finally {
      db.close();
    }
  }
  throw new Error(`Local R2 object not found: ${bucketName}/${key}`);
}

export function runWrangler(args, { cwd = apiDir, timeout = 60000 } = {}) {
  const result = spawnSync(process.execPath, [wranglerCli, ...args], {
    cwd,
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    encoding: 'utf8',
    timeout,
  });
  if (result.status !== 0) {
    throw new Error(`Wrangler failed: ${args.join(' ')}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result.stdout;
}

export function runWranglerAsync(args, { cwd = apiDir, timeout = 60000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [wranglerCli, ...args], {
      cwd,
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new Error(`Wrangler timed out: ${args.join(' ')}`));
    }, timeout);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectRun(new Error(`Wrangler failed: ${args.join(' ')}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }
      resolveRun(stdout);
    });
  });
}

export function executeLocalD1(stateDir, { file, command, json = false }) {
  const args = [
    'd1', 'execute', 'transmission-project-manager-local', '--local', '--persist-to', stateDir, '--yes',
  ];
  if (file) args.push('--file', file);
  if (command) args.push('--command', command);
  if (json) args.push('--json');
  return runWrangler(args);
}

export function queryLocalD1(stateDir, command) {
  return JSON.parse(executeLocalD1(stateDir, { command, json: true }));
}

export function applyLocalMigrations(stateDir) {
  return runWrangler([
    'd1', 'migrations', 'apply', 'transmission-project-manager-local', '--local', '--persist-to', stateDir,
  ]);
}

export async function startWranglerServer({
  stateDir,
  port,
  vars = [],
  seed = false,
  migrate = true,
}) {
  if (migrate) applyLocalMigrations(stateDir);
  if (seed) throw new Error('local seed mode has been removed; bootstrap accounts through the auth API');

  const args = [
    wranglerCli,
    'dev', '--local', '--persist-to', stateDir, '--ip', '127.0.0.1', '--port', String(port),
    '--inspector-port', String(port + 10000),
    '--show-interactive-dev-session=false',
  ];
  for (const variable of vars) args.push('--var', variable);

  const server = spawn(process.execPath, args, {
    cwd: apiDir,
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (chunk) => { output = (output + chunk).slice(-20000); });
  server.stderr.on('data', (chunk) => { output = (output + chunk).slice(-20000); });

  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(`Wrangler exited:\n${output}`);
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        return {
          origin,
          request(path, init = {}) { return fetch(`${origin}${path}`, init); },
          output: () => output,
          async stop() {
            if (server.exitCode !== null) return;
            server.kill('SIGTERM');
            await Promise.race([
              new Promise((resolveExit) => server.once('exit', resolveExit)),
              delay(5000),
            ]);
            if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
          },
        };
      }
    } catch { /* wait */ }
    await delay(250);
  }
  server.kill('SIGKILL');
  throw new Error(`Wrangler failed to start:\n${output}`);
}
