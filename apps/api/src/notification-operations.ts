import { Hono } from 'hono';
import type {
  NotificationContactSummary,
  NotificationOutboxStatus,
  NotificationOutboxSummary,
} from '@tpm/shared';
import {
  calculateFrameworkProgress as frameworkProgress,
  calculateMilestoneDue as milestoneDue,
  currentAnalysisRule as currentRule,
} from './analysis-calculations.ts';
import { requireRoles, type AppEnv } from './auth.ts';
import { replayIdempotentResponse, requestHash, requireIdempotencyKey } from './http/idempotent-mutation.ts';
import { apiError } from './http/request-values.ts';
import type { RuntimeBindings } from './runtime-env';
import { resolvePersistence as createCloudflarePersistence } from './runtime/persistence.ts';
import { SqlAnalysisRepository } from './repositories/sql-analysis-repository.ts';
import { SqlNotificationRepository } from './repositories/sql-notification-repository.ts';
import { SqlOperationJournalRepository } from './repositories/sql-operation-journal-repository.ts';

const MAX_OUTBOX_CLAIM = 50;

function cleanText(value: unknown) { return value === null || value === undefined ? '' : String(value).trim(); }
function safePositive(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null; }
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

export async function deliverNotificationBatch(env: RuntimeBindings, now: string) {
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

export const notificationOperationsApp = new Hono<AppEnv>();

notificationOperationsApp.post('/notification-contacts', requireRoles('admin'), async (c) => {
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

notificationOperationsApp.get('/notification-contacts', requireRoles('admin'), async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlNotificationRepository(database).listContacts() } });
});

notificationOperationsApp.post('/alerts/evaluate', requireRoles('admin','project_manager'), async (c) => {
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

notificationOperationsApp.get('/alerts', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlNotificationRepository(database).listAlerts(200) } });
});

notificationOperationsApp.get('/notification-outbox', requireRoles('admin'), async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlNotificationRepository(database).listOutbox(200) } });
});

notificationOperationsApp.post('/notification-outbox/claim', requireRoles('admin'), async (c) => {
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

notificationOperationsApp.post('/notification-outbox/:id/result', requireRoles('admin'), async (c) => {
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
