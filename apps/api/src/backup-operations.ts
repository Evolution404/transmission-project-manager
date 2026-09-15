import { Hono } from 'hono';
import type { BackupKind, BackupSummary, BackupVerificationSummary } from '@tpm/shared';
import { requireRoles, type AppEnv } from './auth.ts';
import { replayIdempotentResponse, requestHash, requireIdempotencyKey } from './http/idempotent-mutation.ts';
import { apiError } from './http/request-values.ts';
import { BACKUP_TABLES } from './ports/backup-repository.ts';
import { SqlBackupRepository } from './repositories/sql-backup-repository.ts';
import { SqlOperationJournalRepository } from './repositories/sql-operation-journal-repository.ts';
import type { RuntimeBindings } from './runtime-env';
import { resolvePersistence as createCloudflarePersistence } from './runtime/persistence.ts';

const BACKUP_CHUNK_ROWS = 100;

function cleanText(value: unknown) { return value === null || value === undefined ? '' : String(value).trim(); }
function validDate(value: unknown): string | null {
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const d = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(d.valueOf()) || d.toISOString().slice(0, 10) !== text ? null : text;
}
async function sha256Hex(data: ArrayBuffer | Uint8Array) {
  const input = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function ensureBackup(env: RuntimeBindings, backupDate: string, kind: BackupKind) {
  const { database } = createCloudflarePersistence(env);
  return new SqlBackupRepository(database).ensure(backupDate, kind, new Date().toISOString());
}

async function cleanupBackupRetention(env: RuntimeBindings, kind: BackupKind) {
  const { database, objectStore } = createCloudflarePersistence(env);
  const repository = new SqlBackupRepository(database);
  const keep = kind === 'daily' ? 7 : 3;
  for (const run of await repository.retentionCandidates(kind, keep)) {
    for (const key of await repository.chunkObjectKeys(run.id)) await objectStore.delete(key);
    if (run.manifestKey) await objectStore.delete(run.manifestKey);
    await repository.deleteRun(run.id);
  }
}

export async function processBackupStep(env: RuntimeBindings, backupId: string): Promise<BackupSummary | null> {
  const { database, objectStore } = createCloudflarePersistence(env);
  const repository = new SqlBackupRepository(database);
  const run = await repository.find(backupId);
  if (!run) return null;
  if (run.status === 'completed' || run.status === 'failed') return run;
  const now = new Date().toISOString();
  if (run.currentTableIndex >= BACKUP_TABLES.length) {
    const chunks = await repository.listChunks(run.id);
    const attachmentKeys = await repository.listAttachmentKeys();
    const manifest = {
      version: 1,
      backupId: run.id,
      backupDate: run.backupDate,
      kind: run.kind,
      completedAt: now,
      chunks: chunks.map((item) => ({ table: item.tableName, index: item.chunkIndex, key: item.objectKey, rowCount: item.rowCount, sha256: item.sha256 })),
      attachmentKeys,
    };
    const manifestKey = `backups/${run.backupDate}/${run.kind}/${run.id}/manifest.json`;
    await objectStore.put(manifestKey, JSON.stringify(manifest), { contentType: 'application/json' });
    await repository.markCompleted(run.id, manifestKey, now);
    await cleanupBackupRetention(env, run.kind);
    return repository.find(run.id);
  }
  const table = BACKUP_TABLES[run.currentTableIndex]!;
  try {
    const resultRows = await repository.readTableRows(table, run.cursorRowid, BACKUP_CHUNK_ROWS);
    const startedAt = run.startedAt ?? now;
    if (resultRows.length === 0) {
      await repository.advanceEmptyTable(run.id, startedAt, now);
      return repository.find(run.id);
    }
    const chunkIndex = await repository.nextChunkIndex(run.id, table);
    const rowsForBackup = resultRows.map((row) => {
      const { __rowid: _rowid, ...copy } = row;
      return copy;
    });
    const payload = new TextEncoder().encode(JSON.stringify({ table, rows: rowsForBackup }));
    const sha256 = await sha256Hex(payload);
    const objectKey = `backups/${run.backupDate}/${run.kind}/${run.id}/${String(run.currentTableIndex).padStart(2, '0')}-${table}-${chunkIndex}.json`;
    await objectStore.put(objectKey, payload, { contentType: 'application/json' });
    const lastRowid = Number(resultRows.at(-1)!.__rowid);
    const finishedTable = resultRows.length < BACKUP_CHUNK_ROWS;
    try {
      await repository.recordChunk({ backupId: run.id, table, chunkIndex, objectKey, rowCount: resultRows.length, sha256, nextTableIndex: finishedTable ? run.currentTableIndex + 1 : run.currentTableIndex, nextCursorRowid: finishedTable ? 0 : lastRowid, startedAt, now });
    } catch (error) {
      await objectStore.delete(objectKey);
      throw error;
    }
    return repository.find(run.id);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.slice(0, 1000) : 'backup step failed';
    await repository.markFailed(run.id, message, now);
    return repository.find(run.id);
  }
}

async function verifyBackup(env: RuntimeBindings, backupId: string): Promise<BackupVerificationSummary | null> {
  const { database, objectStore } = createCloudflarePersistence(env);
  const repository = new SqlBackupRepository(database);
  const run = await repository.find(backupId);
  if (!run || run.status !== 'completed' || !run.manifestKey) return null;
  const missingObjects: string[] = [], mismatchedObjects: string[] = [];
  const manifestObject = await objectStore.get(run.manifestKey);
  if (!manifestObject) missingObjects.push(run.manifestKey);
  for (const chunk of await repository.listChunks(run.id)) {
    const object = await objectStore.get(chunk.objectKey);
    if (!object) { missingObjects.push(chunk.objectKey); continue; }
    const bytes = await object.bytes();
    if (await sha256Hex(bytes) !== chunk.sha256) mismatchedObjects.push(chunk.objectKey);
  }
  const verified = missingObjects.length === 0 && mismatchedObjects.length === 0;
  const verifiedAt = verified ? new Date().toISOString() : null;
  if (verifiedAt) await repository.markVerified(run.id, verifiedAt);
  return { backupId: run.id, verified, missingObjects, mismatchedObjects, verifiedAt };
}

export async function processNextBackupStep(env: RuntimeBindings) {
  const { database } = createCloudflarePersistence(env);
  const pendingId = await new SqlBackupRepository(database).findPending();
  if (pendingId) await processBackupStep(env, pendingId);
  return pendingId;
}

export const backupOperationsApp = new Hono<AppEnv>();

backupOperationsApp.post('/backups', requireRoles('admin'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const backupDate = validDate(body.backupDate), kind = cleanText(body.kind) as BackupKind;
  if (!backupDate || !['daily','monthly'].includes(kind)) return c.json(apiError('INVALID_BACKUP', '备份日期或类型无效'), 422);
  const request = { backupDate, kind }, hash = await requestHash(request), operation = `backups.create:${backupDate}:${kind}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const ensured = await ensureBackup(c.env, backupDate, kind), actor = c.get('currentUser'), now = new Date().toISOString(), response = { ok: true as const, data: ensured.backup };
  const { database } = createCloudflarePersistence(c.env);
  try { await new SqlOperationJournalRepository(database).record({ auditId: crypto.randomUUID(), actorId: actor.id, action: 'backup.create', objectType: 'backup', objectId: ensured.backup.id, before: null, after: ensured.backup, idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: ensured.created ? 201 : 200, now }); }
  catch { return c.json(apiError('BACKUP_CONFLICT', '备份创建记录冲突'), 409); }
  return c.json(response, ensured.created ? 201 : 200);
});

backupOperationsApp.get('/backups', requireRoles('admin'), async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlBackupRepository(database).list(100) } });
});

backupOperationsApp.post('/backups/:id/step', requireRoles('admin'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const hash = await requestHash({}), operation = `backups.step:${c.req.param('id')}:${key}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const data = await processBackupStep(c.env, c.req.param('id')); if (!data) return c.json(apiError('NOT_FOUND', '备份任务不存在'), 404);
  const actor = c.get('currentUser'), now = new Date().toISOString(), response = { ok: true as const, data };
  const { database } = createCloudflarePersistence(c.env);
  try { await new SqlOperationJournalRepository(database).record({ auditId: crypto.randomUUID(), actorId: actor.id, action: 'backup.step', objectType: 'backup', objectId: data.id, before: null, after: { status: data.status, currentTableIndex: data.currentTableIndex, chunkCount: data.chunkCount }, idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 200, now }); }
  catch { return c.json(apiError('BACKUP_STEP_CONFLICT', '备份步骤记录冲突'), 409); }
  return c.json(response);
});

backupOperationsApp.post('/backups/:id/verify', requireRoles('admin'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const hash = await requestHash({}), operation = `backups.verify:${c.req.param('id')}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const data = await verifyBackup(c.env, c.req.param('id')); if (!data) return c.json(apiError('BACKUP_NOT_READY', '备份不存在或尚未完成'), 422);
  const actor = c.get('currentUser'), now = new Date().toISOString(), response = { ok: true as const, data };
  const { database } = createCloudflarePersistence(c.env);
  try { await new SqlOperationJournalRepository(database).record({ auditId: crypto.randomUUID(), actorId: actor.id, action: 'backup.verify', objectType: 'backup', objectId: data.backupId, before: null, after: data, idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 200, now }); }
  catch { return c.json(apiError('BACKUP_VERIFY_CONFLICT', '备份校验记录冲突'), 409); }
  return c.json(response);
});
