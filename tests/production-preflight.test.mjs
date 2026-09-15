import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateConfig, validateAcceptance, verifyBackup, inspectInputs } from '../scripts/production/lib.mjs';

const productionConfig = () => JSON.parse(readFileSync(new URL('../apps/api/wrangler.production.jsonc', import.meta.url)));
function config() {
  const c = productionConfig();
  c.name = 'tpm-production'; c.account_id = 'a'.repeat(32);
  c.d1_databases[0].database_name = 'tpm-production';
  c.d1_databases[0].database_id = '12345678-1234-4321-8321-123456789abc';
  c.vars.NOTION_STORAGE_DATA_SOURCE_ID = '87654321-4321-4321-8321-cba987654321';
  c.routes[0].pattern = 'projects.business.cn';
  c.secrets = { required: ['AUTH_CREDENTIAL_PEPPER', 'NOTION_API_TOKEN'] };
  return c;
}
function r2Config() {
  const c = config();
  c.vars = { APP_ENV: 'production', OBJECT_STORAGE_PROVIDER: 'r2' };
  c.secrets = { required: ['AUTH_CREDENTIAL_PEPPER'] };
  c.r2_buckets = [{ binding: 'FILES', bucket_name: 'tpm-production-files' }];
  return c;
}

test('local configuration has one dotenv entry point and no legacy Notion/dev-vars files', () => {
  assert.equal(existsSync(new URL('../.env.example', import.meta.url)), true);
  assert.equal(existsSync(new URL('../apps/api/.dev.vars.example', import.meta.url)), false);
  for (const file of ['../scripts/notion/init.mjs', '../scripts/notion/smoke.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /\.env/);
    assert.doesNotMatch(source, /\.env\.notion|\.dev\.vars/);
  }
});
test('tracked production config is valid and placeholder resource IDs are rejected', () => {
  assert.deepEqual(validateConfig(productionConfig()), []);
  const placeholder = productionConfig();
  placeholder.account_id = '00000000000000000000000000000000';
  placeholder.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000';
  assert.ok(validateConfig(placeholder).length > 0);
});
test('production config rejects auth overrides, secret values, missing permanent secret declarations, unsafe routes and wrong bindings', () => {
  for (const mutate of [
    c => { c.vars.APP_ENV = 'development'; },
    c => { c.vars.NOTION_API_TOKEN = 'sensitive-test-value'; },
    c => { c.vars.ACCESS_AUD = 'legacy'; },
    c => { c.secrets = { required: [] }; },
    c => { c.secrets = { required: ['BOOTSTRAP_TOKEN'] }; },
    c => { c.secrets = { required: ['AUTH_CREDENTIAL_PEPPER', 'BOOTSTRAP_TOKEN'] }; },
    c => { c.secrets = ['AUTH_CREDENTIAL_PEPPER']; },
    c => { c.workers_dev = true; },
    c => { c.preview_urls = true; },
    c => { c.assets.run_worker_first = ['/api/*']; },
    c => { c.d1_databases[0].binding = 'OTHER'; },
    c => { c.vars.NOTION_API_VERSION = '2025-09-03'; },
    c => { c.vars.NOTION_STORAGE_DATA_SOURCE_ID = 'test-local'; },
    c => { c.r2_buckets = [{ binding: 'FILES', bucket_name: 'unexpected-r2' }]; },
    c => { c.routes[0].pattern = 'https://example.com/path'; },
    c => { c.triggers.crons = []; },
    c => { c.env = { preview: {} }; },
  ]) {
    const c = config(); mutate(c); const errors = validateConfig(c);
    assert.ok(errors.length > 0);
    assert.ok(!JSON.stringify(errors).includes('sensitive-test-value'));
  }
});
test('production config accepts either Notion or R2 storage but rejects mixed provider settings', () => {
  assert.deepEqual(validateConfig(config()), []);
  assert.deepEqual(validateConfig(r2Config()), []);
  const mixed = r2Config();
  mixed.vars.NOTION_API_VERSION = '2026-03-11';
  mixed.vars.NOTION_STORAGE_DATA_SOURCE_ID = '87654321-4321-4321-8321-cba987654321';
  assert.ok(validateConfig(mixed).length > 0);
});
test('acceptance requires all 13 unique items and actual evidence; pending is not complete', () => {
  const record = JSON.parse(readFileSync(new URL('../docs/templates/production-evidence.example.json', import.meta.url)));
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
  const directory = mkdtempSync(join(tmpdir(), 'tpm-production-'));
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
  const directory = mkdtempSync(join(tmpdir(), 'tpm-production-input-'));
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

test('production promote is the single manual production mutation entry point', () => {
  const source = readFileSync(new URL('../.github/workflows/production-promote.yml', import.meta.url), 'utf8');
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /environment: production/);
  assert.match(source, /release_sha/);
  assert.match(source, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(source, /secrets\.AUTH_CREDENTIAL_PEPPER/);
  assert.match(source, /secrets\.NOTION_API_TOKEN/);
  assert.match(source, /npm run check/);
  assert.match(source, /scripts\/production\/promote\.sh/);
  assert.doesNotMatch(source, /PRODUCTION_DEPLOY_ENABLED|PRODUCTION_CONFIG_JSON|vars\./);
  assert.doesNotMatch(source, /\n  (push|pull_request|schedule|workflow_run):/);
});

test('production promotion rebuilds data in place only after a dry data-transfer plan and has rollback', () => {
  const source = readFileSync(new URL('../scripts/production/promote.sh', import.meta.url), 'utf8');
  assert.match(source, /d1 export DB --remote/);
  assert.match(source, /data-transfer-cli\.mjs/);
  assert.match(source, /MAINTENANCE_MODE:data-migration/);
  assert.match(source, /d1 migrations apply DB --remote/);
  assert.match(source, /verify-remote-transfer\.mjs/);
  assert.match(source, /wrangler_api rollback/);
  assert.match(source, /SOURCE_FINAL/);
  assert.match(source, /ROLLBACK_RESET/);
  assert.doesNotMatch(source, /0002_|production-migrate\.yml/);
});

test('production Cloudflare inventory is manual, environment-bound and read-only', () => {
  const source = readFileSync(new URL('../.github/workflows/production-cloudflare-inventory.yml', import.meta.url), 'utf8');
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /environment: production/);
  assert.match(source, /wrangler\.production\.jsonc/);
  assert.doesNotMatch(source, /inputs\.account_id/);
  assert.match(source, /CLOUDFLARE_API_TOKEN/);
  assert.match(source, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(source, /CLOUDFLARE_READ_API_TOKEN/);
  assert.match(source, /\/accounts\/\$\{ACCOUNT_ID\}\/tokens\/verify/);
  assert.match(source, /Cloudflare API request failed:/);
  assert.match(source, /jq -c '\{success, errors\}'/);
  assert.match(source, /\/workers\/scripts/);
  assert.match(source, /\/d1\/database/);
  assert.match(source, /\/r2\/buckets/);
  assert.match(source, /10042/);
  assert.match(source, /R2 not enabled/);
  assert.match(source, /\/workers\/domains/);
  assert.match(source, /\/zones/);
  assert.doesNotMatch(source, /\n  (push|pull_request|schedule|workflow_run):/);
  assert.doesNotMatch(source, /(?:-X|--request)\s+(?:POST|PUT|PATCH|DELETE)|wrangler\s+(?:deploy|d1\s+migrations\s+apply|d1\s+execute|r2\s+bucket\s+create|secret\s+put)/i);
});
