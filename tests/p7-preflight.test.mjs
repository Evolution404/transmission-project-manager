import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateConfig, validateAcceptance, verifyBackup, inspectInputs } from '../scripts/p7/lib.mjs';

const template = () => JSON.parse(readFileSync(new URL('../apps/api/wrangler.production.example.json', import.meta.url)));
function config() {
  const c = template();
  c.name = 'tpm-production'; c.account_id = 'a'.repeat(32);
  c.d1_databases[0].database_name = 'tpm-production';
  c.d1_databases[0].database_id = '12345678-1234-4321-8321-123456789abc';
  c.r2_buckets[0].bucket_name = 'tpm-production-files';
  c.routes[0].pattern = 'projects.business.cn';
  c.secrets = ['AUTH_CREDENTIAL_PEPPER', 'BOOTSTRAP_TOKEN'];
  return c;
}
test('production config rejects placeholders while valid non-secret config passes', () => {
  assert.ok(validateConfig(template()).length > 0);
  assert.deepEqual(validateConfig(config()), []);
});
test('production config rejects auth overrides, secret values, missing secret declarations, unsafe routes and wrong bindings', () => {
  for (const mutate of [
    c => { c.vars.APP_ENV = 'development'; },
    c => { c.vars.AUTH_CREDENTIAL_PEPPER = 'sensitive-test-value'; },
    c => { c.vars.ACCESS_AUD = 'legacy'; },
    c => { c.secrets = []; },
    c => { c.secrets = ['AUTH_CREDENTIAL_PEPPER']; },
    c => { c.secrets = ['AUTH_CREDENTIAL_PEPPER', 'BOOTSTRAP_TOKEN', 'EXTRA_SECRET']; },
    c => { c.workers_dev = true; },
    c => { c.preview_urls = true; },
    c => { c.assets.run_worker_first = ['/api/*']; },
    c => { c.d1_databases[0].binding = 'OTHER'; },
    c => { c.r2_buckets[0].bucket_name = 'test-local'; },
    c => { c.routes[0].pattern = 'https://example.com/path'; },
    c => { c.triggers.crons = []; },
    c => { c.env = { preview: {} }; },
  ]) {
    const c = config(); mutate(c); const errors = validateConfig(c);
    assert.ok(errors.length > 0);
    assert.ok(!JSON.stringify(errors).includes('sensitive-test-value'));
  }
});
test('acceptance requires all 13 unique items and actual evidence; pending is not complete', () => {
  const record = JSON.parse(readFileSync(new URL('../docs/templates/p7-evidence.example.json', import.meta.url)));
  assert.equal(validateAcceptance(record).complete, false);
  assert.deepEqual(validateAcceptance(record).errors, []);
  record.items[0].status = 'passed';
  assert.ok(validateAcceptance(record).errors.length > 0);
  record.items[0].environment = 'local-synthetic';
  record.items[0].evidence = [{ reference: 'private:record', sha256: 'a'.repeat(64) }];
  record.items[0].reviewer = 'operator'; record.items[0].observedAt = '2026-09-12T01:00:00Z';
  assert.ok(validateAcceptance(record).errors.length > 0);
  record.items[0].environment = 'real-data';
  assert.deepEqual(validateAcceptance(record).errors, []);
  record.items[1].id = record.items[0].id;
  assert.ok(validateAcceptance(record).errors.length > 0);
});
test('backup checks bytes, row counts, contiguous indices, attachment presence and unsafe keys', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tpm-p7-'));
  try {
    const bytes = JSON.stringify({ table: 'members', rows: [{ id: 'synthetic' }] });
    mkdirSync(join(directory, 'backups')); writeFileSync(join(directory, 'backups/chunk.json'), bytes);
    const manifest = { version: 1, backupId: 'synthetic', backupDate: '2026-09-12', kind: 'daily', completedAt: '2026-09-12T00:00:00Z', chunks: [{ table: 'members', index: 0, key: 'backups/chunk.json', rowCount: 1, sha256: createHash('sha256').update(bytes).digest('hex') }], attachmentKeys: [] };
    assert.equal((await verifyBackup(manifest, directory)).errors.length, 0);
    for (const mutate of [
      m => { m.chunks[0].sha256 = '0'.repeat(64); },
      m => { m.chunks[0].rowCount = 2; },
      m => { m.chunks[0].index = 1; },
      m => { m.chunks.push(m.chunks[0]); },
      m => { m.chunks[0].key = '../outside'; },
      m => { m.chunks[0].table = 'auth_sessions'; },
      m => { m.attachmentKeys = ['missing-attachment']; },
    ]) { const m = structuredClone(manifest); mutate(m); assert.ok((await verifyBackup(m, directory)).errors.length > 0); }
    writeFileSync(join(directory, 'backups/chunk.json'), '{}');
    assert.ok((await verifyBackup(manifest, directory)).errors.length > 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('input inventory hashes files without returning original data and flags old XLS', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tpm-p7-input-'));
  try {
    writeFileSync(join(directory, 'demand.csv'), 'private business data');
    writeFileSync(join(directory, 'old.xls'), 'legacy');
    const inventory = await inspectInputs([join(directory, 'demand.csv'), join(directory, 'old.xls')]);
    assert.equal(inventory.files[0].sha256.length, 64);
    assert.equal(inventory.files[1].supported, false);
    assert.ok(!JSON.stringify(inventory).includes('private business data'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('push CI and manual production preflight contain no cloud mutation or credentials', () => {
  for (const file of ['ci.yml', 'production-preflight.yml']) {
    const source = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /secrets\.|CLOUDFLARE_API_TOKEN|--remote|wrangler deploy(?! --dry-run)/);
  }
  const source = readFileSync(new URL('../.github/workflows/production-preflight.yml', import.meta.url), 'utf8');
  assert.match(source, /workflow_dispatch/);
  assert.doesNotMatch(source, /\n  (push|pull_request|schedule|workflow_run):/);
  assert.match(source, /environment: production/);
});

test('production deploy is manual, environment-bound, version-bound and never auto-migrates data', () => {
  const source = readFileSync(new URL('../.github/workflows/production-deploy.yml', import.meta.url), 'utf8');
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /environment: production/);
  assert.match(source, /PRODUCTION_DEPLOY_ENABLED/);
  assert.match(source, /release_sha/);
  assert.match(source, /CLOUDFLARE_API_TOKEN/);
  assert.match(source, /npm run check/);
  assert.match(source, /wrangler deploy --config wrangler\.production\.jsonc/);
  assert.doesNotMatch(source, /\n  (push|pull_request|schedule|workflow_run):|d1 migrations apply|d1 execute/);
});

test('production migration is a separate manual workflow bound to exact main revision', () => {
  const source = readFileSync(new URL('../.github/workflows/production-migrate.yml', import.meta.url), 'utf8');
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /environment: production/);
  assert.match(source, /PRODUCTION_DEPLOY_ENABLED/);
  assert.match(source, /release_sha/);
  assert.match(source, /CLOUDFLARE_API_TOKEN/);
  assert.match(source, /d1 migrations list DB --remote/);
  assert.match(source, /d1 migrations apply DB --remote/);
  assert.doesNotMatch(source, /\n  (push|pull_request|schedule|workflow_run):|wrangler deploy --config/);
});
