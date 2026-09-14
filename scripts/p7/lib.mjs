// Offline only. Never contacts Cloudflare, opens a session, or deploys resources.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const shaPattern = /^[a-f0-9]{64}$/;
const placeholder = value => !nonempty(value) || /replace|example|placeholder|local|^0[-0]*$/i.test(value);

export function validateConfig(c) {
  const errors = [];
  const need = (ok, field) => { if (!ok) errors.push(`Invalid production config: ${field}`); };
  const keys = (value, allowed, field) => need(object(value) && Object.keys(value).every(key => allowed.includes(key)), field);
  if (!object(c)) return ['Production config must be an object'];
  keys(c, ['$schema', 'name', 'account_id', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'assets', 'vars', 'secrets', 'triggers', 'routes', 'd1_databases', 'r2_buckets'], 'top-level keys');
  need(!placeholder(c.name) && /^[a-z0-9-]{1,63}$/.test(c.name), 'name');
  need(/^[a-f0-9]{32}$/.test(c.account_id) && !placeholder(c.account_id), 'account_id');
  need(c.main === 'src/index.ts', 'main');
  need(c.compatibility_date === '2026-09-12', 'tested compatibility_date');
  need(c.workers_dev === false && c.preview_urls === false, 'public preview routes');
  need(same(c.vars, { APP_ENV: 'production' }), 'vars (Secrets belong in Worker Secrets)');
  need(same(c.secrets, ['AUTH_CREDENTIAL_PEPPER']), 'required permanent Worker Secret names');
  keys(c.assets, ['directory', 'binding', 'not_found_handling', 'run_worker_first'], 'assets keys');
  need(c.assets?.directory === '../web/dist' && c.assets?.binding === 'ASSETS' && c.assets?.not_found_handling === 'single-page-application' && same(c.assets?.run_worker_first, ['/api', '/api/*']), 'assets routing');
  need(same(c.triggers, { crons: ['*/5 * * * *'] }), 'cron');
  need(Array.isArray(c.routes) && c.routes.length === 1, 'routes');
  for (const route of Array.isArray(c.routes) ? c.routes : []) {
    keys(route, ['pattern', 'custom_domain'], 'route keys');
    need(route?.custom_domain === true && !placeholder(route?.pattern) && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(route?.pattern), 'custom domain');
  }
  need(Array.isArray(c.d1_databases) && c.d1_databases.length === 1, 'D1 count');
  for (const db of Array.isArray(c.d1_databases) ? c.d1_databases : []) {
    keys(db, ['binding', 'database_name', 'database_id', 'migrations_dir'], 'D1 keys');
    need(db?.binding === 'DB' && db?.migrations_dir === 'migrations', 'D1 binding');
    need(!placeholder(db?.database_name) && /^[a-z0-9-]{1,63}$/.test(db?.database_name), 'D1 name');
    need(!placeholder(db?.database_id) && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(db?.database_id), 'D1 ID');
  }
  need(Array.isArray(c.r2_buckets) && c.r2_buckets.length === 1, 'R2 count');
  for (const bucket of Array.isArray(c.r2_buckets) ? c.r2_buckets : []) {
    keys(bucket, ['binding', 'bucket_name'], 'R2 keys');
    need(bucket?.binding === 'FILES' && !placeholder(bucket?.bucket_name) && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket?.bucket_name), 'private R2 binding');
  }
  return errors;
}

export function validateAcceptance(record) {
  const errors = [], pending = [];
  const ids = Array.from({ length: 13 }, (_, i) => `P7-${String(i + 1).padStart(2, '0')}`);
  if (!object(record) || record.version !== 1 || !Array.isArray(record.items)) return { errors: ['Invalid evidence record'], pending: ids, complete: false };
  if (!same(record.items.map(i => i?.id).sort(), ids)) errors.push('Exactly 13 distinct P7 IDs required');
  for (const item of record.items) {
    if (!object(item) || !ids.includes(item.id)) { errors.push('Unknown acceptance item'); continue; }
    if (!['blocked', 'pending', 'failed', 'passed'].includes(item.status)) errors.push(`${item.id}: invalid status`);
    if (item.status !== 'passed') { pending.push(item.id); continue; }
    const expectedEnvironment = Number(item.id.slice(3)) <= 5 ? 'real-data' : 'production';
    if (item.environment !== expectedEnvironment || !nonempty(item.reviewer) || !nonempty(item.observedAt) || !Number.isFinite(Date.parse(item.observedAt))) errors.push(`${item.id}: real environment, reviewer and timestamp required`);
    if (!Array.isArray(item.evidence) || !item.evidence.length || item.evidence.some(e => !object(e) || !nonempty(e.reference) || !shaPattern.test(e.sha256))) errors.push(`${item.id}: evidence references and SHA-256 required`);
  }
  return { errors, pending, complete: !errors.length && !pending.length };
}

export async function inspectInputs(paths) {
  if (!paths.length) throw new Error('At least one private input file required');
  const files = [];
  for (const path of paths) {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) throw new Error('Input must be a nonempty file');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const extension = extname(path).toLowerCase();
    files.push({ name: basename(path), bytes: info.size, sha256: hash.digest('hex'), supported: ['.xlsx', '.csv'].includes(extension), action: extension === '.xls' ? '另存为 .xlsx；保留原件和转换件哈希' : '使用浏览器导入页核对映射和物理源行，尚未验收' });
  }
  return { kind: 'input-inventory-only', files };
}

export async function verifyBackup(manifest, directory) {
  const errors = [], rowsByTable = {}, seenKeys = new Set(), indices = new Map();
  if (!object(manifest) || manifest.version !== 1 || !nonempty(manifest.backupId) || !Array.isArray(manifest.chunks) || !Array.isArray(manifest.attachmentKeys)) return { errors: ['Invalid P6 manifest'], rowsByTable, restored: false };
  const root = await realpath(directory);
  async function safePath(key) {
    if (!nonempty(key) || key.startsWith('/') || key.includes('\\') || key.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('unsafe key');
    const target = await realpath(resolve(root, key));
    if (!target.startsWith(root + sep) || !(await stat(target)).isFile()) throw new Error('unsafe object');
    return target;
  }
  for (let i = 0; i < manifest.chunks.length; i++) {
    const chunk = manifest.chunks[i];
    try {
      if (!object(chunk) || !/^[a-z_]+$/.test(chunk.table) || ['auth_sessions', 'backup_runs', 'backup_chunks', 'sqlite_sequence', 'd1_migrations'].includes(chunk.table) || !Number.isSafeInteger(chunk.index) || chunk.index < 0 || !Number.isSafeInteger(chunk.rowCount) || chunk.rowCount < 1 || chunk.rowCount > 100 || !shaPattern.test(chunk.sha256) || seenKeys.has(chunk.key)) throw new Error('invalid chunk');
      seenKeys.add(chunk.key);
      const path = await safePath(chunk.key);
      if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error('chunk too large for offline verifier');
      const bytes = await readFile(path);
      if (createHash('sha256').update(bytes).digest('hex') !== chunk.sha256) throw new Error('checksum mismatch');
      const body = JSON.parse(bytes);
      if (body.table !== chunk.table || !Array.isArray(body.rows) || body.rows.length !== chunk.rowCount || body.rows.some(row => !object(row))) throw new Error('row count/table mismatch');
      const previous = indices.get(chunk.table) ?? [];
      previous.push(chunk.index); indices.set(chunk.table, previous);
      rowsByTable[chunk.table] = (rowsByTable[chunk.table] ?? 0) + body.rows.length;
    } catch { errors.push(`Chunk ${i}: missing, unsafe, malformed or checksum mismatch`); }
  }
  for (const [table, values] of indices) if (values.sort((a, b) => a - b).some((v, i) => v !== i)) errors.push(`Non-contiguous or duplicate indices: ${table}`);
  const attachmentKeys = new Set();
  for (let i = 0; i < manifest.attachmentKeys.length; i++) {
    const key = manifest.attachmentKeys[i];
    try { if (attachmentKeys.has(key) || seenKeys.has(key)) throw new Error('duplicate'); attachmentKeys.add(key); await safePath(key); }
    catch { errors.push(`Attachment ${i}: missing, duplicate or unsafe`); }
  }
  return { errors, rowsByTable, attachmentCount: manifest.attachmentKeys.length, restored: false, note: 'Integrity only; no snapshot consistency, attachment content hash, completeness or actual restore proof' };
}