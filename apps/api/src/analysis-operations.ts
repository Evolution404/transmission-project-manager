import { Hono, type Context } from 'hono';
import type {
  AnalysisDashboardSummary,
  AnalysisLagMode,
  AnalysisRuleSummary,
  ApiError,
  BackupKind,
  BackupSummary,
  BackupVerificationSummary,
  MilestoneDatePrecision,
  MilestoneStatus,
  MilestoneSummary,
  MonthlyPlanSummary,
  MonthlyReportSummary,
  NotificationContactSummary,
  NotificationOutboxStatus,
  NotificationOutboxSummary,
  ReserveRemainingSummary,
} from '@tpm/shared';
import {
  analysisMonthEnd as monthEnd,
  bigintToSafeNumber as bigintToSafe,
  calculateFrameworkProgress as frameworkProgress,
  calculateMilestoneDue as milestoneDue,
  calculateProjectGaps as projectGaps,
  currentAnalysisRule as currentRule,
} from './analysis-calculations.ts';
import { hasScope, requireRoles, type AppEnv } from './auth.ts';
import { replayIdempotentResponse, requestHash, requireIdempotencyKey } from './http/idempotent-mutation.ts';
import { apiError } from './http/request-values.ts';
import type { RuntimeBindings } from './runtime-env';
import { resolvePersistence as createCloudflarePersistence } from './runtime/persistence.ts';
import { SqlOperationJournalRepository } from './repositories/sql-operation-journal-repository.ts';
import { SqlAnalysisRepository } from './repositories/sql-analysis-repository.ts';
import { SqlNotificationRepository } from './repositories/sql-notification-repository.ts';
import { SqlBackupRepository } from './repositories/sql-backup-repository.ts';
import { BACKUP_TABLES } from './ports/backup-repository.ts';

const BACKUP_CHUNK_ROWS = 100;
const MAX_OUTBOX_CLAIM = 50;

function cleanText(value: unknown) { return value === null || value === undefined ? '' : String(value).trim(); }
function safeNonNegative(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function safePositive(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null; }
function expectedVersion(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null; }
function validDate(value: unknown): string | null {
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const d = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(d.valueOf()) || d.toISOString().slice(0, 10) !== text ? null : text;
}
function validIso(value: unknown): string | null {
  const text = cleanText(value);
  return text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : null;
}
function validMonth(value: unknown): string | null {
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}$/.test(text)) return null;
  const month = Number(text.slice(5, 7));
  return month >= 1 && month <= 12 ? text : null;
}
async function sha256Hex(data: ArrayBuffer | Uint8Array) {
  const input = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
function canFramework(c: Context<AppEnv>, frameworkId: string) {
  const user = c.get('currentUser');
  return user.role === 'admin' || hasScope(user.scopes, 'framework', frameworkId);
}
function canProject(c: Context<AppEnv>, projectId: string) {
  const user = c.get('currentUser');
  return user.role === 'admin' || hasScope(user.scopes, 'project', projectId);
}
function canProjectOrFramework(c: Context<AppEnv>, projectId: string, frameworkId: string | null) {
  return canProject(c, projectId) || (frameworkId !== null && canFramework(c, frameworkId));
}
export async function evaluateAlerts(env: RuntimeBindings, asOf: string) {
  const { database } = createCloudflarePersistence(env);
  const analysis = new SqlAnalysisRepository(database);
  const notifications = new SqlNotificationRepository(database);
  const rule = await currentRule(analysis);
  let createdEvents = 0;
  const now = `${asOf}T00:00:00.000Z`;
  const frameworks = await analysis.listFrameworkIds();
  for (const frameworkId of frameworks) {
    const progress = await frameworkProgress(analysis, frameworkId, asOf);
    if (!progress || !rule) continue;
    const recipients = await notifications.verifiedRecipients(frameworkId, null);
    if (progress.lagging) {
      const event = await notifications.ensureAlert({ ruleKey: 'analysis.lag', ruleVersion: rule.version, objectType: 'framework', objectId: frameworkId, periodKey: asOf.slice(0, 7), severity: 'warning', message: `${progress.frameworkName} 实际进度低于同期计划`, now, recipients });
      if (event.created) createdEvents += 1;
      else if (event.firstSeenAt.slice(0, 10) < asOf) await notifications.ensureDailySummary(event.eventId, asOf, now, recipients);
    } else {
      createdEvents += await notifications.resolveActiveAlerts({ ruleKey: 'analysis.lag', objectId: frameworkId, now, recipients });
    }
  }
  const milestoneRows = await analysis.listOpenMilestones();
  for (const row of milestoneRows) {
    const due = milestoneDue(row, asOf);
    if (!due.reminderDue) continue;
    const recipients = await notifications.verifiedRecipients(null, row.projectId);
    const periodKey = row.datePrecision === 'month' ? `${asOf.slice(0, 7)}:${asOf}` : asOf;
    const event = await notifications.ensureAlert({ ruleKey: 'milestone.due', ruleVersion: row.version, objectType: 'milestone', objectId: row.id, periodKey, severity: due.overdue ? 'warning' : 'info', message: `年度事项：${row.title}`, now, recipients });
    if (event.created) createdEvents += 1;
  }
  return { createdEvents };
}

function retryAt(now: string, attemptCount: number) {
  const minutes = Math.min(24 * 60, 5 * (2 ** Math.max(0, attemptCount - 1)));
  return new Date(Date.parse(now) + minutes * 60_000).toISOString();
}

async function deliverNotificationBatch(env: RuntimeBindings, now: string) {
  const url = env.NOTIFICATION_DELIVERY_URL?.trim();
  if (!url) return { configured: false, processed: 0, sent: 0, failed: 0, unknown: 0 };
  const { database } = createCloudflarePersistence(env);
  const repository = new SqlNotificationRepository(database);
  const items = await repository.claimOutbox(now, 10, 90);
  let sent = 0, failed = 0, unknown = 0;
  for (const item of items) {
    if (!item.leaseToken) continue;
    const row = await repository.findOutbox(item.id);
    if (!row || row.status !== 'leased' || row.leaseToken !== item.leaseToken) continue;
    const event = await repository.findDeliveryEvent(row.eventId);
    if (!event) {
      const attempts = row.attemptCount + 1;
      await repository.completeOutboxLease({ row, leaseToken: item.leaseToken, status: 'failed', attempts, nextAttemptAt: retryAt(now, attempts), error: 'alert event missing', updatedAt: now });
      failed += 1;
      continue;
    }
    let outcome: 'sent' | 'failed' | 'unknown' = 'unknown';
    let error: string | null = null;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = env.NOTIFICATION_DELIVERY_TOKEN?.trim();
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ notificationId: row.id, eventId: row.eventId, to: row.recipient, subject: `[输电项目管理] ${event.severity === 'critical' ? '重要预警' : event.severity === 'warning' ? '预警提醒' : '事项提醒'}`, text: event.message, ruleKey: event.ruleKey }),
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) outcome = 'sent';
      else { outcome = 'failed'; error = `delivery HTTP ${response.status}`; }
    } catch (cause) {
      outcome = 'unknown';
      error = cause instanceof Error ? cause.message.slice(0, 1000) : 'delivery result unknown';
    }
    const attempts = row.attemptCount + 1;
    await repository.completeOutboxLease({ row, leaseToken: item.leaseToken, status: outcome, attempts, nextAttemptAt: outcome === 'failed' ? retryAt(now, attempts) : now, error, updatedAt: now });
    if (outcome === 'sent') sent += 1;
    else if (outcome === 'failed') failed += 1;
    else unknown += 1;
  }
  return { configured: true, processed: items.length, sent, failed, unknown };
}

async function ensureBackup(env: RuntimeBindings, backupDate: string, kind: BackupKind) {
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
function shanghaiParts(nowIso: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowIso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return { businessDate: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
}
function isMonthEnd(date: string) { return date === monthEnd(date.slice(0, 7)); }
export async function runScheduledOperations(env: RuntimeBindings, nowIso: string) {
  const normalized = validIso(nowIso);
  if (!normalized) throw new Error('invalid scheduled time');
  const local = shanghaiParts(normalized);
  const alerts = await evaluateAlerts(env, local.businessDate);
  const notificationDelivery = await deliverNotificationBatch(env, normalized);
  let backupCreated = false;
  if (local.hour === 3 && local.minute < 5) {
    const daily = await ensureBackup(env, local.businessDate, 'daily');
    backupCreated = daily.created;
    if (isMonthEnd(local.businessDate)) await ensureBackup(env, local.businessDate, 'monthly');
  }
  const { database } = createCloudflarePersistence(env);
  const pendingId = await new SqlBackupRepository(database).findPending();
  if (pendingId) await processBackupStep(env, pendingId);
  return { businessDate: local.businessDate, backupCreated, createdEvents: alerts.createdEvents, notificationDelivery, backupProcessed: pendingId };
}

async function currentReserveRemaining(c: Context<AppEnv>): Promise<{ data: ReserveRemainingSummary | null; error: ApiError | null }> {
  const user = c.get('currentUser');
  const access = { memberId: user.id, unrestricted: user.role === 'admin' || user.scopes.some((scope) => scope.type === 'all') };
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlAnalysisRepository(database);
  const rows = await repository.reserveMaterialFacts(access);

  let currentMaterialQuantity = 0n;
  let knownCurrentMaterialAmount = 0n;
  let unclassifiedCurrentMaterial = 0n;
  let missingPriceCount = 0;
  const categoryTotals = new Map<string, { categoryKey: string; label: string; amount: bigint }>();
  for (const row of rows) {
    currentMaterialQuantity += BigInt(Number(row.requiredQuantityScaled));
    if (row.amountFen === null) {
      missingPriceCount += 1;
      continue;
    }
    const amount = BigInt(Number(row.amountFen));
    knownCurrentMaterialAmount += amount;
    if (!row.reserveCategoryId || !row.categoryKey || !row.label) {
      unclassifiedCurrentMaterial += amount;
      continue;
    }
    const current = categoryTotals.get(row.reserveCategoryId) ?? { categoryKey: row.categoryKey, label: row.label, amount: 0n };
    current.amount += amount;
    categoryTotals.set(row.reserveCategoryId, current);
  }

  const releasedProjectCount = await repository.releasedProjectCount(access);
  const quantityNumber = bigintToSafe(currentMaterialQuantity);
  const knownNumber = bigintToSafe(knownCurrentMaterialAmount);
  const unclassifiedNumber = bigintToSafe(unclassifiedCurrentMaterial);
  if ([quantityNumber, knownNumber, unclassifiedNumber].some((value) => value === null)) {
    return { data: null, error: apiError('ANALYSIS_AMOUNT_OVERFLOW', '储备项目物资汇总超出安全整数范围') };
  }
  const categories = [...categoryTotals.entries()].map(([reserveCategoryId, value]) => ({
    reserveCategoryId,
    categoryKey: value.categoryKey,
    label: value.label,
    knownCurrentAmountFen: bigintToSafe(value.amount),
  })).filter((item): item is { reserveCategoryId: string; categoryKey: string; label: string; knownCurrentAmountFen: number } => item.knownCurrentAmountFen !== null)
    .sort((a, b) => b.knownCurrentAmountFen - a.knownCurrentAmountFen || a.label.localeCompare(b.label));
  if (categories.length !== categoryTotals.size) return { data: null, error: apiError('ANALYSIS_AMOUNT_OVERFLOW', '储备类别金额汇总超出安全整数范围') };
  return {
    data: {
      currentMaterialQuantityScaled: quantityNumber!,
      knownCurrentMaterialAmountFen: knownNumber!,
      missingPriceCount,
      unclassifiedCurrentMaterialFen: unclassifiedNumber!,
      releasedProjectCount,
      unscopedCommonCostFen: 0,
      categories,
    },
    error: null,
  };
}

async function dashboardSummary(c: Context<AppEnv>, asOf: string): Promise<AnalysisDashboardSummary> {
  const user = c.get('currentUser');
  const access = { memberId: user.id, unrestricted: user.role === 'admin' || user.scopes.some((scope) => scope.type === 'all') };
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlAnalysisRepository(database);
  const facts = await repository.dashboardFacts(access);
  let activeAlertCount = 0;
  for (const row of await repository.activeAlertReferences()) {
    if (row.objectType === 'framework' && canFramework(c, row.objectId)) activeAlertCount += 1;
    else if (row.objectType === 'project' && canProject(c, row.objectId)) activeAlertCount += 1;
    else if (row.objectType === 'milestone' && (!row.milestoneProjectId || canProject(c, row.milestoneProjectId))) activeAlertCount += 1;
  }
  return { asOf, ...facts, activeAlertCount };
}

export const analysisOperationsApp = new Hono<AppEnv>();

analysisOperationsApp.get('/analysis/dashboard', async (c) => {
  const asOf = validDate(c.req.query('asOf')); if (!asOf) return c.json(apiError('INVALID_AS_OF', 'asOf 必须为有效日期'), 400);
  return c.json({ ok: true as const, data: await dashboardSummary(c, asOf) });
});

analysisOperationsApp.get('/analysis/reserve-remaining', async (c) => {
  const result = await currentReserveRemaining(c);
  if (result.error) return c.json(result.error, result.error.error.code === 'ANALYSIS_AMOUNT_OVERFLOW' ? 422 : 500);
  return c.json({ ok: true as const, data: result.data! });
});

analysisOperationsApp.get('/analysis/rules', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  const row = await currentRule(new SqlAnalysisRepository(database));
  if (!row) return c.json(apiError('ANALYSIS_RULE_MISSING', '分析规则未配置'), 500);
  return c.json({ ok: true as const, data: row });
});

analysisOperationsApp.put('/analysis/rules', requireRoles('admin'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion), mode = cleanText(body.mode) as AnalysisLagMode, threshold = safeNonNegative(body.thresholdBasisPoints);
  if (version === null || !['ratio','gap'].includes(mode) || threshold === null || threshold > 10000) return c.json(apiError('INVALID_ANALYSIS_RULE', '分析规则参数无效'), 422);
  const request = { expectedVersion: version, mode, thresholdBasisPoints: threshold };
  const hash = await requestHash(request), operation = 'analysis.rules.put'; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlAnalysisRepository(database);
  const current = await currentRule(repository); if (!current || current.version !== version) return c.json(apiError('VERSION_CONFLICT', '分析规则已被修改，请刷新后重试'), 409);
  const actor = c.get('currentUser'), now = new Date().toISOString(), next = version + 1, id = crypto.randomUUID();
  const data: AnalysisRuleSummary = { id, version: next, mode, thresholdBasisPoints: threshold, effectiveFrom: now, createdAt: now };
  const response = { ok: true as const, data };
  try {
    await repository.createRule({ current, next: data, meta: { actorId: actor.id, auditId: crypto.randomUUID(), idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 200, now } });
  } catch { return c.json(apiError('VERSION_CONFLICT', '分析规则已被并发修改，请刷新后重试'), 409); }
  return c.json(response);
});

analysisOperationsApp.get('/analysis/plans', async (c) => {
  const frameworkId = cleanText(c.req.query('frameworkId')), year = Number(c.req.query('year'));
  if (!frameworkId || !Number.isInteger(year) || year < 2000 || year > 2200) return c.json(apiError('INVALID_QUERY', 'frameworkId 和 year 必须有效'), 400);
  if (!canFramework(c, frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该框架月计划'), 403);
  const { database } = createCloudflarePersistence(c.env);
  const items = await new SqlAnalysisRepository(database).listPlans(frameworkId, year);
  return c.json({ ok: true as const, data: { items } });
});

analysisOperationsApp.put('/analysis/plans/:projectId/:year/:month', requireRoles('admin','project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const projectId = cleanText(c.req.param('projectId')), year = Number(c.req.param('year')), month = Number(c.req.param('month'));
  if (!projectId || !Number.isInteger(year) || year < 2000 || year > 2200 || !Number.isInteger(month) || month < 1 || month > 12) return c.json(apiError('INVALID_PLAN_KEY', '计划项目、年份或月份无效'), 422);
  if (!canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权维护该项目计划'), 403);
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlAnalysisRepository(database);
  const project = await repository.findProject(projectId); if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expected = body.expectedVersion === null ? null : expectedVersion(body.expectedVersion), target = safeNonNegative(body.targetAmountFen);
  if ((body.expectedVersion !== null && expected === null) || target === null) return c.json(apiError('INVALID_PLAN', '计划版本或金额无效'), 422);
  const request = { expectedVersion: expected, targetAmountFen: target }, hash = await requestHash(request), operation = `analysis.plan.put:${projectId}:${year}:${month}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const current = await repository.findPlan(projectId, year, month);
  if ((current?.version ?? null) !== expected) return c.json(apiError('VERSION_CONFLICT', '月计划已被修改，请刷新后重试', { currentVersion: current?.version ?? null }), 409);
  const actor = c.get('currentUser'), now = new Date().toISOString(), id = current?.id ?? crypto.randomUUID(), next = (current?.version ?? 0) + 1;
  const data: MonthlyPlanSummary = { id, projectId, businessYear: year, month, targetAmountFen: target, version: next, createdAt: current?.createdAt ?? now, updatedAt: now };
  const response = { ok: true as const, data };
  try { await repository.putPlan({ previous: current, next: data, meta: { actorId: actor.id, auditId: crypto.randomUUID(), idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 200, now } }); }
  catch { return c.json(apiError('VERSION_CONFLICT', '月计划已被并发修改，请刷新后重试'), 409); }
  return c.json(response);
});

analysisOperationsApp.get('/analysis/frameworks/:id/progress', async (c) => {
  const asOf = validDate(c.req.query('asOf')); if (!asOf) return c.json(apiError('INVALID_AS_OF', 'asOf 必须为有效日期'), 400);
  if (!canFramework(c, c.req.param('id'))) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该框架分析'), 403);
  const { database } = createCloudflarePersistence(c.env);
  const data = await frameworkProgress(new SqlAnalysisRepository(database), c.req.param('id'), asOf); if (!data) return c.json(apiError('NOT_FOUND', '框架不存在'), 404);
  return c.json({ ok: true as const, data });
});

analysisOperationsApp.get('/analysis/projects/gaps', async (c) => {
  const frameworkId = cleanText(c.req.query('frameworkId')), asOf = validDate(c.req.query('asOf'));
  if (!frameworkId || !asOf) return c.json(apiError('INVALID_QUERY', 'frameworkId 和 asOf 必须有效'), 400);
  if (!canFramework(c, frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该框架分析'), 403);
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await projectGaps(new SqlAnalysisRepository(database), frameworkId, asOf) } });
});

analysisOperationsApp.post('/reports/monthly', requireRoles('admin','project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const frameworkId = cleanText(body.frameworkId), businessMonth = validMonth(body.businessMonth), dataCutoffDate = validDate(body.dataCutoffDate);
  if (!frameworkId || !businessMonth || !dataCutoffDate || dataCutoffDate < monthEnd(businessMonth)) return c.json(apiError('INVALID_REPORT', '月报月份或数据截止日无效；正式月报截止日不能早于月末'), 422);
  if (!canFramework(c, frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权生成该框架月报'), 403);
  const request = { frameworkId, businessMonth, dataCutoffDate }, hash = await requestHash(request), operation = `reports.monthly.create:${frameworkId}:${businessMonth}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlAnalysisRepository(database);
  const progress = await frameworkProgress(repository, frameworkId, dataCutoffDate); if (!progress) return c.json(apiError('NOT_FOUND', '框架不存在'), 404);
  const gaps = await projectGaps(repository, frameworkId, dataCutoffDate), rule = progress.rule;
  const revision = await repository.nextReportRevision(frameworkId, businessMonth), id = crypto.randomUUID(), actor = c.get('currentUser'), now = new Date().toISOString();
  const snapshot = { progress, projectGaps: gaps }, data: MonthlyReportSummary = { id, frameworkId, businessMonth, revision, dataCutoffDate, ruleVersion: rule.version, rule, snapshot, createdAt: now };
  const response = { ok: true as const, data };
  try { await repository.createReport({ report: data, meta: { actorId: actor.id, auditId: crypto.randomUUID(), idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 201, now } }); }
  catch { return c.json(apiError('REPORT_CONFLICT', '月报修订创建冲突'), 409); }
  return c.json(response, 201);
});

analysisOperationsApp.get('/reports/monthly', async (c) => {
  const frameworkId = cleanText(c.req.query('frameworkId')), businessMonth = validMonth(c.req.query('businessMonth'));
  if (!frameworkId || !businessMonth) return c.json(apiError('INVALID_QUERY', 'frameworkId 和 businessMonth 必须有效'), 400);
  if (!canFramework(c, frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该框架月报'), 403);
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlAnalysisRepository(database).listReports(frameworkId, businessMonth) } });
});

analysisOperationsApp.post('/milestones', requireRoles('admin','project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const businessYear = Number(body.businessYear), title = cleanText(body.title), owner = body.owner === null || body.owner === undefined || body.owner === '' ? null : cleanText(body.owner), projectId = body.projectId === null || body.projectId === undefined || body.projectId === '' ? null : cleanText(body.projectId), datePrecision = cleanText(body.datePrecision) as MilestoneDatePrecision;
  const month = body.month === null || body.month === undefined ? null : Number(body.month), specificDate = body.specificDate === null || body.specificDate === undefined || body.specificDate === '' ? null : validDate(body.specificDate);
  const leadDays = Array.isArray(body.leadDays) ? [...new Set(body.leadDays.map(Number))].filter((value) => Number.isInteger(value) && value >= 0 && value <= 365).sort((a, b) => b - a) : [];
  if (!Number.isInteger(businessYear) || businessYear < 2000 || businessYear > 2200 || !title || title.length > 200 || (owner !== null && !owner) || !['month','day','unknown'].includes(datePrecision) || !Array.isArray(body.leadDays) || leadDays.length !== body.leadDays.length) return c.json(apiError('INVALID_MILESTONE', '年度事项参数无效'), 422);
  if (projectId && !canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权关联该项目'), 403);
  if (datePrecision === 'month' && (!month || month < 1 || month > 12 || specificDate !== null)) return c.json(apiError('INVALID_MILESTONE_DATE', '月份精度只能保存月份，不能捏造具体日期'), 422);
  if (datePrecision === 'day' && (!month || month < 1 || month > 12 || !specificDate || Number(specificDate.slice(0,4)) !== businessYear || Number(specificDate.slice(5,7)) !== month)) return c.json(apiError('INVALID_MILESTONE_DATE', '日期精度必须保存同年度同月份的具体日期'), 422);
  if (datePrecision === 'unknown' && (month !== null || specificDate !== null)) return c.json(apiError('INVALID_MILESTONE_DATE', '未知日期不能保存月份或具体日期'), 422);
  const request = { businessYear, title, owner, projectId, datePrecision, month, specificDate, leadDays }, hash = await requestHash(request), operation = 'milestones.create'; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), id = crypto.randomUUID(), now = new Date().toISOString();
  const data: MilestoneSummary = { id, businessYear, title, owner, projectId, datePrecision, month, specificDate, leadDays, status: 'open', version: 1, createdAt: now, updatedAt: now };
  const response = { ok: true as const, data };
  const { database } = createCloudflarePersistence(c.env);
  try { await new SqlAnalysisRepository(database).createMilestone({ milestone: data, meta: { actorId: actor.id, auditId: crypto.randomUUID(), idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 201, now } }); }
  catch { return c.json(apiError('MILESTONE_CONFLICT', '年度事项写入冲突'), 409); }
  return c.json(response, 201);
});

analysisOperationsApp.get('/milestones', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  const items = (await new SqlAnalysisRepository(database).listMilestones()).filter((item) => !item.projectId || canProject(c, item.projectId));
  return c.json({ ok: true as const, data: { items } });
});

analysisOperationsApp.get('/milestones/due', async (c) => {
  const asOf = validDate(c.req.query('asOf')); if (!asOf) return c.json(apiError('INVALID_AS_OF', 'asOf 必须为有效日期'), 400);
  const { database } = createCloudflarePersistence(c.env);
  const items = (await new SqlAnalysisRepository(database).listMilestones()).filter((item) => !item.projectId || canProject(c, item.projectId)).map((item) => milestoneDue(item, asOf));
  return c.json({ ok: true as const, data: { items } });
});

analysisOperationsApp.put('/milestones/:id/status', requireRoles('admin','project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion), status = cleanText(body.status) as MilestoneStatus;
  if (version === null || !['open','completed'].includes(status)) return c.json(apiError('INVALID_MILESTONE_STATUS', '事项版本或状态无效'), 422);
  const request = { expectedVersion: version, status }, hash = await requestHash(request), operation = `milestones.status:${c.req.param('id')}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlAnalysisRepository(database);
  const current = await repository.findMilestone(c.req.param('id'));
  if (!current) return c.json(apiError('NOT_FOUND', '年度事项不存在'), 404);
  if (current.projectId && !canProject(c, current.projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权修改该事项'), 403);
  if (current.version !== version) return c.json(apiError('VERSION_CONFLICT', '年度事项已被修改，请刷新后重试'), 409);
  const actor = c.get('currentUser'), now = new Date().toISOString();
  const data: MilestoneSummary = { ...current, status, version: version + 1, updatedAt: now }, response = { ok: true as const, data };
  try {
    await repository.updateMilestoneStatus({ current, status, next: data, meta: { actorId: actor.id, auditId: crypto.randomUUID(), idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 200, now } });
  } catch {
    const raceReplay = await replayIdempotentResponse(c, key, operation, hash); if (raceReplay) return raceReplay;
    return c.json(apiError('VERSION_CONFLICT', '年度事项已被并发修改，请刷新后重试'), 409);
  }
  return c.json(response);
});

analysisOperationsApp.post('/notification-contacts', requireRoles('admin'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const memberId = cleanText(body.memberId), address = cleanText(body.address).toLowerCase(), verified = body.verified === true, enabled = body.enabled !== false;
  if (!memberId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return c.json(apiError('INVALID_CONTACT', '通知成员或地址无效'), 422);
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlNotificationRepository(database);
  if (!await repository.memberExists(memberId)) return c.json(apiError('MEMBER_NOT_FOUND', '成员不存在'), 404);
  const request = { memberId, address, verified, enabled }, hash = await requestHash(request), operation = 'notification-contacts.create'; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), id = crypto.randomUUID(), now = new Date().toISOString(), verifiedAt = verified ? now : null;
  const data: NotificationContactSummary = { id, memberId, address, verifiedAt, enabled, version: 1, createdAt: now, updatedAt: now }, response = { ok: true as const, data };
  try { await repository.createContact({ contact: data, journal: { auditId: crypto.randomUUID(), actorId: actor.id, action: 'notification-contact.create', objectType: 'notification_contact', objectId: id, before: null, after: data, idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 201, now } }); }
  catch { return c.json(apiError('CONTACT_CONFLICT', '通知地址已存在或写入冲突'), 409); }
  return c.json(response, 201);
});

analysisOperationsApp.get('/notification-contacts', requireRoles('admin'), async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlNotificationRepository(database).listContacts() } });
});

analysisOperationsApp.post('/alerts/evaluate', requireRoles('admin','project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const asOf = validDate(body.asOf); if (!asOf) return c.json(apiError('INVALID_AS_OF', 'asOf 必须为有效日期'), 422);
  const request = { asOf }, hash = await requestHash(request), operation = `alerts.evaluate:${asOf}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const data = await evaluateAlerts(c.env, asOf), actor = c.get('currentUser'), now = new Date().toISOString(), response = { ok: true as const, data };
  const { database } = createCloudflarePersistence(c.env);
  try { await new SqlOperationJournalRepository(database).record({ auditId: crypto.randomUUID(), actorId: actor.id, action: 'alerts.evaluate', objectType: 'alert_cycle', objectId: asOf, before: null, after: data, idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 200, now }); }
  catch { return c.json(apiError('ALERT_EVALUATION_CONFLICT', '预警评估记录冲突'), 409); }
  return c.json(response);
});

analysisOperationsApp.get('/alerts', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlNotificationRepository(database).listAlerts(200) } });
});

analysisOperationsApp.get('/notification-outbox', requireRoles('admin'), async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlNotificationRepository(database).listOutbox(200) } });
});

analysisOperationsApp.post('/notification-outbox/claim', requireRoles('admin'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const now = validIso(body.now), limit = safePositive(body.limit), leaseSeconds = safePositive(body.leaseSeconds);
  if (!now || limit === null || limit > MAX_OUTBOX_CLAIM || leaseSeconds === null || leaseSeconds > 3600) return c.json(apiError('INVALID_CLAIM', '领取时间、数量或租约时长无效'), 422);
  const request = { now, limit, leaseSeconds }, hash = await requestHash(request), operation = `notification-outbox.claim:${key}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const { database } = createCloudflarePersistence(c.env);
  const items = await new SqlNotificationRepository(database).claimOutbox(now, limit, leaseSeconds), actor = c.get('currentUser'), storedAt = new Date().toISOString(), response = { ok: true as const, data: { items } };
  try { await new SqlOperationJournalRepository(database).record({ auditId: crypto.randomUUID(), actorId: actor.id, action: 'notification-outbox.claim', objectType: 'notification_outbox', objectId: key, before: null, after: { count: items.length }, idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 200, now: storedAt }); }
  catch { return c.json(apiError('CLAIM_CONFLICT', '通知领取记录冲突'), 409); }
  return c.json(response);
});

analysisOperationsApp.post('/notification-outbox/:id/result', requireRoles('admin'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const leaseToken = cleanText(body.leaseToken), outcome = cleanText(body.outcome), now = validIso(body.now), error = body.error === null || body.error === undefined || body.error === '' ? null : cleanText(body.error).slice(0, 1000);
  if (!leaseToken || !['sent','failed','unknown'].includes(outcome) || !now) return c.json(apiError('INVALID_DELIVERY_RESULT', '通知结果参数无效'), 422);
  const request = { leaseToken, outcome, now, error }, hash = await requestHash(request), operation = `notification-outbox.result:${c.req.param('id')}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlNotificationRepository(database);
  const row = await repository.findOutbox(c.req.param('id'));
  if (!row) return c.json(apiError('NOT_FOUND', '通知不存在'), 404);
  if (row.status !== 'leased' || row.leaseToken !== leaseToken) return c.json(apiError('LEASE_CONFLICT', '通知租约已失效'), 409);
  const attempts = row.attemptCount + 1, status = outcome as NotificationOutboxStatus, nextAttemptAt = outcome === 'failed' ? retryAt(now, attempts) : now;
  const actor = c.get('currentUser'), updatedAt = new Date().toISOString();
  const data: NotificationOutboxSummary = { ...row, status, leaseToken: null, leasedAt: null, leaseUntil: null, attemptCount: attempts, nextAttemptAt, lastError: error, updatedAt };
  const response = { ok: true as const, data };
  try { await repository.completeOutboxLease({ row, leaseToken, status, attempts, nextAttemptAt, error, updatedAt, journal: { auditId: crypto.randomUUID(), actorId: actor.id, action: 'notification-outbox.result', objectType: 'notification_outbox', objectId: row.id, before: { status: row.status, attemptCount: row.attemptCount }, after: { status, attemptCount: attempts }, idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 200, now: updatedAt } }); }
  catch { return c.json(apiError('DELIVERY_RESULT_CONFLICT', '通知结果写入冲突'), 409); }
  return c.json(response);
});

analysisOperationsApp.post('/backups', requireRoles('admin'), async (c) => {
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

analysisOperationsApp.get('/backups', requireRoles('admin'), async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlBackupRepository(database).list(100) } });
});

analysisOperationsApp.post('/backups/:id/step', requireRoles('admin'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const hash = await requestHash({}), operation = `backups.step:${c.req.param('id')}:${key}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const data = await processBackupStep(c.env, c.req.param('id')); if (!data) return c.json(apiError('NOT_FOUND', '备份任务不存在'), 404);
  const actor = c.get('currentUser'), now = new Date().toISOString(), response = { ok: true as const, data };
  const { database } = createCloudflarePersistence(c.env);
  try { await new SqlOperationJournalRepository(database).record({ auditId: crypto.randomUUID(), actorId: actor.id, action: 'backup.step', objectType: 'backup', objectId: data.id, before: null, after: { status: data.status, currentTableIndex: data.currentTableIndex, chunkCount: data.chunkCount }, idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 200, now }); }
  catch { return c.json(apiError('BACKUP_STEP_CONFLICT', '备份步骤记录冲突'), 409); }
  return c.json(response);
});

analysisOperationsApp.post('/backups/:id/verify', requireRoles('admin'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const hash = await requestHash({}), operation = `backups.verify:${c.req.param('id')}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const data = await verifyBackup(c.env, c.req.param('id')); if (!data) return c.json(apiError('BACKUP_NOT_READY', '备份不存在或尚未完成'), 422);
  const actor = c.get('currentUser'), now = new Date().toISOString(), response = { ok: true as const, data };
  const { database } = createCloudflarePersistence(c.env);
  try { await new SqlOperationJournalRepository(database).record({ auditId: crypto.randomUUID(), actorId: actor.id, action: 'backup.verify', objectType: 'backup', objectId: data.backupId, before: null, after: data, idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 200, now }); }
  catch { return c.json(apiError('BACKUP_VERIFY_CONFLICT', '备份校验记录冲突'), 409); }
  return c.json(response);
});

analysisOperationsApp.post('/system/tasks/run', requireRoles('admin'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const nowInput = validIso(body.now); if (!nowInput) return c.json(apiError('INVALID_SCHEDULED_TIME', 'now 必须为有效 ISO 时间'), 422);
  const request = { now: nowInput }, hash = await requestHash(request), operation = `system.tasks.run:${nowInput}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const data = await runScheduledOperations(c.env, nowInput), actor = c.get('currentUser'), storedAt = new Date().toISOString(), response = { ok: true as const, data };
  const { database } = createCloudflarePersistence(c.env);
  try { await new SqlOperationJournalRepository(database).record({ auditId: crypto.randomUUID(), actorId: actor.id, action: 'system.tasks.run', objectType: 'scheduled_tick', objectId: nowInput, before: null, after: data, idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 200, now: storedAt }); }
  catch { return c.json(apiError('TASK_RUN_CONFLICT', '后台任务运行记录冲突'), 409); }
  return c.json(response);
});
