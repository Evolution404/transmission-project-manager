import { Hono } from 'hono';
import { analysisMonthEnd as monthEnd } from './analysis-calculations.ts';
import { requireRoles, type AppEnv } from './auth.ts';
import { ensureBackup, processNextBackupStep } from './backup-operations.ts';
import { replayIdempotentResponse, requestHash, requireIdempotencyKey } from './http/idempotent-mutation.ts';
import { apiError } from './http/request-values.ts';
import { deliverNotificationBatch, evaluateAlerts } from './notification-operations.ts';
import { SqlOperationJournalRepository } from './repositories/sql-operation-journal-repository.ts';
import type { RuntimeBindings } from './runtime-env';
import { resolvePersistence as createCloudflarePersistence } from './runtime/persistence.ts';

function cleanText(value: unknown) { return value === null || value === undefined ? '' : String(value).trim(); }
function validIso(value: unknown): string | null {
  const text = cleanText(value);
  return text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : null;
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
  const pendingId = await processNextBackupStep(env);
  return { businessDate: local.businessDate, backupCreated, createdEvents: alerts.createdEvents, notificationDelivery, backupProcessed: pendingId };
}

export const systemTasksApp = new Hono<AppEnv>();

systemTasksApp.post('/system/tasks/run', requireRoles('admin'), async (c) => {
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
