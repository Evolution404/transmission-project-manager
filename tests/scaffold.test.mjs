import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const wranglerPackage = require('wrangler/package.json');
const wranglerCli = resolve(dirname(require.resolve('wrangler/package.json')), wranglerPackage.bin.wrangler);
const origin = 'http://127.0.0.1:8799';
let server;
let exited;
let output = '';

before(async () => {
  server = spawn(process.execPath, [wranglerCli, 'dev', '--local', '--ip', '127.0.0.1', '--port', '8799'], {
    cwd: fileURLToPath(new URL('../apps/api/', import.meta.url)),
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  exited = new Promise((resolve) => server.once('exit', resolve));
  server.stdout.on('data', (chunk) => { output = (output + chunk).slice(-12000); });
  server.stderr.on('data', (chunk) => { output = (output + chunk).slice(-12000); });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error(`Wrangler exited:\n${output}`);
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Wait for the local runtime to start. */ }
    await delay(500);
  }
  throw new Error(`Wrangler failed to start:\n${output}`);
}, { timeout: 70000 });

after(async () => {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([exited, delay(5000)]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
});

test('built SPA is served by the local Workers asset binding', async () => {
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await response.text(), /输电项目全流程管理台/);
});

test('API health runs in workerd and explicitly reports scaffold status', async () => {
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, data: { service: 'transmission-project-manager', stage: 'scaffold' },
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('unknown API routes return JSON 404 instead of the SPA HTML fallback', async () => {
  for (const pathname of ['/api', '/api/not-implemented']) {
    const response = await fetch(`${origin}${pathname}`, { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' } });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  }
});
