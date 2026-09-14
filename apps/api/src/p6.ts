import { Hono, type Context } from 'hono';
import type {
  AlertEventSummary,
  AnalysisDashboardSummary,
  AnalysisLagMode,
  AnalysisRuleSummary,
  ApiError,
  BackupKind,
  BackupStatus,
  BackupSummary,
  BackupVerificationSummary,
  FrameworkProgressSummary,
  MilestoneDatePrecision,
  MilestoneDueSummary,
  MilestoneStatus,
  MilestoneSummary,
  MonthlyPlanSummary,
  MonthlyReportSummary,
  NotificationContactSummary,
  NotificationOutboxStatus,
  NotificationOutboxSummary,
  ProjectGapSummary,
  QuarterProgressSummary,
  ReserveRemainingSummary,
} from '@tpm/shared';
import { hasScope, requireRoles, type AppEnv } from './auth';
import type { WorkerBindings } from './env';
import { createCloudflarePersistence } from './runtime/cloudflare/persistence';
import { SqlIdempotencyRepository } from './repositories/sql-idempotency-repository';
import { SqlOperationJournalRepository } from './repositories/sql-operation-journal-repository';
import { SqlAnalysisRepository } from './repositories/sql-analysis-repository';
import type { AnalysisRepository } from './ports/analysis-repository';
import { SqlNotificationRepository } from './repositories/sql-notification-repository';

const DEFAULT_RULE_MODE: AnalysisLagMode = 'ratio';
const DEFAULT_RULE_THRESHOLD_BP = 8000;
const BACKUP_CHUNK_ROWS = 100;
const MAX_OUTBOX_CLAIM = 50;
const BACKUP_TABLES = [
  'members', 'member_scopes', 'settings_versions', 'dictionary_items', 'audit_events', 'idempotency_records',
  'voltage_levels', 'transmission_lines', 'transmission_towers',
  'materials', 'import_mapping_templates', 'import_batches', 'import_rows', 'demands', 'demand_source_rows', 'demand_materials', 'field_definitions',
  'projects', 'project_versions', 'demand_allocations', 'project_cost_lines', 'reserve_categories', 'category_mappings', 'category_cost_allocations',
  'project_demand_links', 'project_material_requirements', 'project_material_revisions',
  'frameworks', 'framework_versions', 'agreements', 'agreement_versions', 'project_budgets', 'budget_allocations', 'budget_versions',
  'budget_version_allocations', 'financial_entries', 'financial_entry_allocations',
  'project_releases', 'project_tasks', 'task_demand_scopes', 'task_material_requirements', 'material_supply_events',
  'task_implementation_records', 'task_implementation_scope_lines', 'task_material_usage_lines',
  'task_settlements', 'task_settlement_scope_lines', 'task_settlement_agreement_allocations', 'task_settlement_reminders',
  'release_batches', 'release_lines', 'implementation_records', 'implementation_lines', 'settlements', 'settlement_coverage',
  'settlement_agreement_allocations', 'attachments',
  'analysis_rules', 'monthly_plans', 'report_snapshots', 'annual_milestones', 'notification_contacts', 'alert_events', 'notification_outbox',
] as const;

type RuleRow = { id: string; version: number; mode: AnalysisLagMode; threshold_basis_points: number; effective_from: string; created_at: string };
type PlanRow = { id: string; project_id: string; business_year: number; month: number; target_amount_fen: number; version: number; created_at: string; updated_at: string };
type FrameworkRow = { id: string; code: string; name: string; total_amount_fen: number; annual_target_fen: number | null; start_date: string; end_date: string };
type ReportRow = { id: string; framework_id: string; business_month: string; revision: number; data_cutoff_date: string; rule_version: number; rule_json: string; snapshot_json: string; created_at: string };
type MilestoneRow = { id: string; business_year: number; title: string; owner: string | null; project_id: string | null; date_precision: MilestoneDatePrecision; month: number | null; specific_date: string | null; lead_days_json: string; status: MilestoneStatus; version: number; created_at: string; updated_at: string };
type ContactRow = { id: string; member_id: string; address: string; verified_at: string | null; enabled: number; version: number; created_at: string; updated_at: string };
type AlertRow = { id: string; rule_key: string; rule_version: number; object_type: string; object_id: string; period_key: string; severity: 'info' | 'warning' | 'critical'; state: 'active' | 'resolved'; message: string; first_seen_at: string; last_seen_at: string; resolved_at: string | null };
type OutboxRow = { id: string; event_id: string; recipient: string; status: NotificationOutboxStatus; lease_token: string | null; lease_until: string | null; attempt_count: number; next_attempt_at: string; last_error: string | null; created_at: string; updated_at: string };
type BackupRow = { id: string; backup_date: string; kind: BackupKind; status: BackupStatus; current_table_index: number; cursor_rowid: number; manifest_key: string | null; chunk_count: number; error: string | null; started_at: string | null; completed_at: string | null; verified_at: string | null; created_at: string; updated_at: string };
type BackupChunkRow = { id: string; backup_run_id: string; table_name: string; chunk_index: number; r2_key: string; row_count: number; sha256: string; created_at: string };

function apiError(code: string, message: string, details?: unknown): ApiError {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}
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
function requireIdempotencyKey(c: Context<AppEnv>): string | Response {
  const key = c.req.header('Idempotency-Key')?.trim();
  if (!key || key.length > 200) return c.json(apiError('IDEMPOTENCY_KEY_REQUIRED', '变更请求必须提供有效的 Idempotency-Key'), 400);
  return key;
}
async function requestHash(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return sha256Hex(bytes);
}
async function sha256Hex(data: ArrayBuffer | Uint8Array) {
  const input = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
async function replayIdempotentResponse(c: Context<AppEnv>, key: string, operation: string, hash: string) {
  const actor = c.get('currentUser');
  const { database } = createCloudflarePersistence(c.env);
  const row = await new SqlIdempotencyRepository(database).findByKey(key);
  if (!row) return null;
  if (row.actorMemberId !== actor.id || row.operation !== operation || row.requestHash !== hash) return c.json(apiError('IDEMPOTENCY_CONFLICT', '该 Idempotency-Key 已用于不同请求'), 409);
  return new Response(row.responseJson, { status: row.statusCode, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' } });
}
function idempotencyStatement(db: D1Database, key: string, actorId: string, operation: string, hash: string, response: unknown, statusCode: number, now: string) {
  return db.prepare(`INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at) VALUES (?,?,?,?,?,?,?)`).bind(key, actorId, operation, hash, JSON.stringify(response), statusCode, now);
}
function auditStatement(db: D1Database, actorId: string, action: string, objectType: string, objectId: string, before: unknown, after: unknown, now: string) {
  return db.prepare(`INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), actorId, action, objectType, objectId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), now);
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
function projectAccessFilter(c: Context<AppEnv>, alias = 'p') {
  const user = c.get('currentUser');
  if (user.role === 'admin' || user.scopes.some((scope) => scope.type === 'all')) return { sql: '1=1', binds: [] as string[] };
  const projectIds = user.scopes.filter((scope) => scope.type === 'project' && scope.id).map((scope) => scope.id!);
  const frameworkIds = user.scopes.filter((scope) => scope.type === 'framework' && scope.id).map((scope) => scope.id!);
  const clauses: string[] = [], binds: string[] = [];
  if (projectIds.length) {
    clauses.push(`${alias}.id IN (${projectIds.map(() => '?').join(',')})`);
    binds.push(...projectIds);
  }
  if (frameworkIds.length) {
    clauses.push(`${alias}.framework_id IN (${frameworkIds.map(() => '?').join(',')})`);
    binds.push(...frameworkIds);
  }
  return { sql: clauses.length ? `(${clauses.join(' OR ')})` : '0=1', binds };
}
function bigintToSafe(value: bigint): number | null {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : null;
}
function prorateFen(amountFen: number, remainingQuantityScaled: number, allocatedQuantityScaled: number) {
  if (amountFen === 0 || remainingQuantityScaled <= 0 || allocatedQuantityScaled <= 0) return 0;
  const numerator = BigInt(amountFen) * BigInt(remainingQuantityScaled);
  return bigintToSafe((numerator + BigInt(Math.floor(allocatedQuantityScaled / 2))) / BigInt(allocatedQuantityScaled));
}
function ruleSummary(row: RuleRow): AnalysisRuleSummary {
  return { id: row.id, version: row.version, mode: row.mode, thresholdBasisPoints: row.threshold_basis_points, effectiveFrom: row.effective_from, createdAt: row.created_at };
}
function planSummary(row: PlanRow): MonthlyPlanSummary {
  return { id: row.id, projectId: row.project_id, businessYear: row.business_year, month: row.month, targetAmountFen: row.target_amount_fen, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}
function milestoneSummary(row: MilestoneRow): MilestoneSummary {
  let leadDays: number[] = [];
  try { leadDays = JSON.parse(row.lead_days_json) as number[]; } catch { leadDays = []; }
  return { id: row.id, businessYear: row.business_year, title: row.title, owner: row.owner, projectId: row.project_id, datePrecision: row.date_precision, month: row.month, specificDate: row.specific_date, leadDays, status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}
function contactSummary(row: ContactRow): NotificationContactSummary {
  return { id: row.id, memberId: row.member_id, address: row.address, verifiedAt: row.verified_at, enabled: row.enabled === 1, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}
function alertSummary(row: AlertRow): AlertEventSummary {
  return { id: row.id, ruleKey: row.rule_key, ruleVersion: row.rule_version, objectType: row.object_type, objectId: row.object_id, periodKey: row.period_key, severity: row.severity, state: row.state, message: row.message, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, resolvedAt: row.resolved_at };
}
function outboxSummary(row: OutboxRow, leasedAt: string | null = null): NotificationOutboxSummary {
  return { id: row.id, eventId: row.event_id, recipient: row.recipient, status: row.status, leaseToken: row.lease_token, leasedAt, leaseUntil: row.lease_until, attemptCount: row.attempt_count, nextAttemptAt: row.next_attempt_at, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at };
}
function backupSummary(row: BackupRow): BackupSummary {
  return { id: row.id, backupDate: row.backup_date, kind: row.kind, status: row.status, currentTableIndex: row.current_table_index, cursorRowid: row.cursor_rowid, manifestKey: row.manifest_key, chunkCount: row.chunk_count, error: row.error, startedAt: row.started_at, completedAt: row.completed_at, verifiedAt: row.verified_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
async function currentRule(repository: AnalysisRepository) {
  return repository.currentRule();
}
function ratioBasisPoints(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  const value = (BigInt(numerator) * 10000n + BigInt(Math.floor(denominator / 2))) / BigInt(denominator);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}
function elapsedMonths(businessYear: number, asOf: string) {
  const year = Number(asOf.slice(0, 4));
  if (year < businessYear) return 0;
  if (year > businessYear) return 12;
  return Number(asOf.slice(5, 7));
}
function quarterStatus(businessYear: number, quarter: 1 | 2 | 3 | 4, asOf: string): QuarterProgressSummary['status'] {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const start = `${businessYear}-${String(startMonth).padStart(2, '0')}-01`;
  const end = monthEnd(`${businessYear}-${String(endMonth).padStart(2, '0')}`);
  if (asOf < start) return 'upcoming';
  if (asOf > end) return 'ended';
  return 'in_progress';
}
function monthEnd(month: string) {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7));
  return new Date(Date.UTC(year, monthIndex, 0)).toISOString().slice(0, 10);
}
function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function dayDifference(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

async function frameworkProgress(repository: AnalysisRepository, frameworkId: string, asOf: string): Promise<FrameworkProgressSummary | null> {
  const framework = await repository.findFramework(frameworkId);
  if (!framework) return null;
  const storedRule = await currentRule(repository);
  const rule = storedRule ?? { id: 'default', version: 1, mode: DEFAULT_RULE_MODE, thresholdBasisPoints: DEFAULT_RULE_THRESHOLD_BP, effectiveFrom: '1970-01-01T00:00:00.000Z', createdAt: '1970-01-01T00:00:00.000Z' };
  const businessYear = Number(framework.startDate.slice(0, 4));
  const months = elapsedMonths(businessYear, asOf);
  const annualTargetFen = framework.annualTargetFen ?? framework.totalAmountFen;
  const planMeta = await repository.planMeta(frameworkId, businessYear, months);
  const hasCustom = planMeta.countAll > 0;
  let plannedToDateFen = planMeta.cumulativeFen;
  if (!hasCustom && annualTargetFen > 0) plannedToDateFen = Number((BigInt(annualTargetFen) * BigInt(months)) / 12n);
  const actualToDateFen = await repository.actualFrameworkOccurrence(frameworkId, businessYear, asOf);
  const annualTargetConfigured = annualTargetFen > 0;
  const plannedProgressBasisPoints = annualTargetConfigured ? ratioBasisPoints(plannedToDateFen, annualTargetFen) : null;
  const actualProgressBasisPoints = annualTargetConfigured ? ratioBasisPoints(actualToDateFen, annualTargetFen) : null;
  const attainmentBasisPoints = plannedToDateFen > 0 ? ratioBasisPoints(actualToDateFen, plannedToDateFen) : null;
  let lagging = false;
  if (annualTargetConfigured && plannedToDateFen > 0) {
    if (rule.mode === 'ratio') lagging = BigInt(actualToDateFen) * 10000n < BigInt(plannedToDateFen) * BigInt(rule.thresholdBasisPoints);
    else if (plannedToDateFen > actualToDateFen) lagging = BigInt(plannedToDateFen - actualToDateFen) * 10000n >= BigInt(annualTargetFen) * BigInt(rule.thresholdBasisPoints);
  }
  const quarters: QuarterProgressSummary[] = ([1, 2, 3, 4] as const).map((quarter) => ({ quarter, cumulativeTargetBasisPoints: quarter * 2500, status: quarterStatus(businessYear, quarter, asOf) }));
  return { frameworkId, frameworkCode: framework.code, frameworkName: framework.name, businessYear, asOf, annualTargetFen, annualTargetConfigured, plannedToDateFen, actualToDateFen, plannedProgressBasisPoints, actualProgressBasisPoints, attainmentBasisPoints, lagging, planSource: hasCustom ? 'custom' : 'default', rule, quarters };
}

async function projectGaps(repository: AnalysisRepository, frameworkId: string, asOf: string): Promise<ProjectGapSummary[]> {
  const businessYear = Number(asOf.slice(0, 4));
  const months = elapsedMonths(businessYear, asOf);
  const rows = await repository.projectGapFacts(frameworkId, businessYear, months, asOf);
  return rows.map((row) => ({ ...row, gapFen: Math.max(0, row.plannedToDateFen - row.actualToDateFen) })).sort((a, b) => b.gapFen - a.gapFen || a.projectName.localeCompare(b.projectName));
}

function reportSummary(row: ReportRow): MonthlyReportSummary {
  return { id: row.id, frameworkId: row.framework_id, businessMonth: row.business_month, revision: row.revision, dataCutoffDate: row.data_cutoff_date, ruleVersion: row.rule_version, rule: JSON.parse(row.rule_json) as AnalysisRuleSummary, snapshot: JSON.parse(row.snapshot_json) as MonthlyReportSummary['snapshot'], createdAt: row.created_at };
}
function milestoneDue(base: MilestoneSummary, asOf: string): MilestoneDueSummary {
  if (base.status === 'completed') return { ...base, dueMonth: base.month ? `${base.businessYear}-${String(base.month).padStart(2, '0')}` : null, dueDate: base.specificDate, needsDate: base.datePrecision === 'unknown', reminderDue: false, reminderLeadDays: null, overdue: false };
  if (base.datePrecision === 'unknown') return { ...base, dueMonth: null, dueDate: null, needsDate: true, reminderDue: false, reminderLeadDays: null, overdue: false };
  const dueMonth = `${base.businessYear}-${String(base.month).padStart(2, '0')}`;
  if (base.datePrecision === 'month') {
    const first = `${dueMonth}-01`, end = monthEnd(dueMonth);
    return { ...base, dueMonth, dueDate: null, needsDate: false, reminderDue: asOf >= first, reminderLeadDays: null, overdue: asOf > end };
  }
  const dueDate = base.specificDate!;
  const diff = dayDifference(asOf, dueDate);
  const leadDays = base.leadDays.find((item) => item === diff) ?? null;
  return { ...base, dueMonth, dueDate, needsDate: false, reminderDue: diff < 0 || leadDays !== null, reminderLeadDays: leadDays, overdue: diff < 0 };
}
export async function evaluateAlerts(env: WorkerBindings, asOf: string) {
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

async function deliverNotificationBatch(env: WorkerBindings, now: string) {
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

async function ensureBackup(env: WorkerBindings, backupDate: string, kind: BackupKind) {
  const existing = await env.DB.prepare(`SELECT id,backup_date,kind,status,current_table_index,cursor_rowid,manifest_key,chunk_count,error,started_at,completed_at,verified_at,created_at,updated_at FROM backup_runs WHERE backup_date=? AND kind=? LIMIT 1`).bind(backupDate, kind).first<BackupRow>();
  if (existing) return { created: false, backup: backupSummary(existing) };
  const id = crypto.randomUUID(), now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO backup_runs (id,backup_date,kind,status,current_table_index,cursor_rowid,manifest_key,chunk_count,error,started_at,completed_at,verified_at,created_at,updated_at) VALUES (?,? ,?,'pending',0,0,NULL,0,NULL,NULL,NULL,NULL,?,?)`).bind(id, backupDate, kind, now, now).run();
  const row = await env.DB.prepare(`SELECT id,backup_date,kind,status,current_table_index,cursor_rowid,manifest_key,chunk_count,error,started_at,completed_at,verified_at,created_at,updated_at FROM backup_runs WHERE id=?`).bind(id).first<BackupRow>();
  return { created: true, backup: backupSummary(row!) };
}
async function loadBackup(db: D1Database, id: string) {
  return db.prepare(`SELECT id,backup_date,kind,status,current_table_index,cursor_rowid,manifest_key,chunk_count,error,started_at,completed_at,verified_at,created_at,updated_at FROM backup_runs WHERE id=? LIMIT 1`).bind(id).first<BackupRow>();
}
async function cleanupBackupRetention(env: WorkerBindings, kind: BackupKind) {
  const keep = kind === 'daily' ? 7 : 3;
  const old = await env.DB.prepare(`SELECT id,manifest_key FROM backup_runs WHERE kind=? AND status='completed' ORDER BY backup_date DESC,completed_at DESC LIMIT 100 OFFSET ?`).bind(kind, keep).all<{ id: string; manifest_key: string | null }>();
  for (const run of old.results ?? []) {
    const chunks = await env.DB.prepare(`SELECT r2_key FROM backup_chunks WHERE backup_run_id=?`).bind(run.id).all<{ r2_key: string }>();
    for (const chunk of chunks.results ?? []) await env.FILES.delete(chunk.r2_key);
    if (run.manifest_key) await env.FILES.delete(run.manifest_key);
    await env.DB.prepare(`DELETE FROM backup_runs WHERE id=?`).bind(run.id).run();
  }
}
export async function processBackupStep(env: WorkerBindings, backupId: string): Promise<BackupSummary | null> {
  const run = await loadBackup(env.DB, backupId);
  if (!run) return null;
  if (run.status === 'completed' || run.status === 'failed') return backupSummary(run);
  const now = new Date().toISOString();
  if (run.current_table_index >= BACKUP_TABLES.length) {
    const chunks = await env.DB.prepare(`SELECT id,backup_run_id,table_name,chunk_index,r2_key,row_count,sha256,created_at FROM backup_chunks WHERE backup_run_id=? ORDER BY table_name,chunk_index`).bind(run.id).all<BackupChunkRow>();
    const attachments = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE deleted_at IS NULL ORDER BY r2_key`).all<{ r2_key: string }>();
    const manifest = {
      version: 1,
      backupId: run.id,
      backupDate: run.backup_date,
      kind: run.kind,
      completedAt: now,
      chunks: (chunks.results ?? []).map((item) => ({ table: item.table_name, index: item.chunk_index, key: item.r2_key, rowCount: item.row_count, sha256: item.sha256 })),
      attachmentKeys: (attachments.results ?? []).map((item) => item.r2_key),
    };
    const manifestKey = `backups/${run.backup_date}/${run.kind}/${run.id}/manifest.json`;
    await env.FILES.put(manifestKey, JSON.stringify(manifest), { httpMetadata: { contentType: 'application/json' } });
    await env.DB.prepare(`UPDATE backup_runs SET status='completed',manifest_key=?,completed_at=?,updated_at=? WHERE id=?`).bind(manifestKey, now, now, run.id).run();
    await cleanupBackupRetention(env, run.kind);
    return backupSummary((await loadBackup(env.DB, run.id))!);
  }
  const table = BACKUP_TABLES[run.current_table_index]!;
  try {
    const result = await env.DB.prepare(`SELECT rowid AS __rowid,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`).bind(run.cursor_rowid, BACKUP_CHUNK_ROWS).all<Record<string, unknown> & { __rowid: number }>();
    const resultRows = result.results ?? [];
    const startedAt = run.started_at ?? now;
    if (resultRows.length === 0) {
      await env.DB.prepare(`UPDATE backup_runs SET status='running',current_table_index=current_table_index+1,cursor_rowid=0,started_at=?,updated_at=? WHERE id=?`).bind(startedAt, now, run.id).run();
      return backupSummary((await loadBackup(env.DB, run.id))!);
    }
    const chunkMeta = await env.DB.prepare(`SELECT COALESCE(MAX(chunk_index),-1)+1 AS next_index FROM backup_chunks WHERE backup_run_id=? AND table_name=?`).bind(run.id, table).first<{ next_index: number }>();
    const chunkIndex = Number(chunkMeta?.next_index ?? 0);
    const rowsForBackup = resultRows.map((row) => {
      const { __rowid: _rowid, ...copy } = row;
      return copy;
    });
    const payload = new TextEncoder().encode(JSON.stringify({ table, rows: rowsForBackup }));
    const sha256 = await sha256Hex(payload);
    const r2Key = `backups/${run.backup_date}/${run.kind}/${run.id}/${String(run.current_table_index).padStart(2, '0')}-${table}-${chunkIndex}.json`;
    await env.FILES.put(r2Key, payload, { httpMetadata: { contentType: 'application/json' } });
    const lastRowid = Number(resultRows.at(-1)!.__rowid);
    const finishedTable = resultRows.length < BACKUP_CHUNK_ROWS;
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO backup_chunks (id,backup_run_id,table_name,chunk_index,r2_key,row_count,sha256,created_at) VALUES (?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), run.id, table, chunkIndex, r2Key, resultRows.length, sha256, now),
        env.DB.prepare(`UPDATE backup_runs SET status='running',current_table_index=?,cursor_rowid=?,chunk_count=chunk_count+1,started_at=?,updated_at=? WHERE id=?`).bind(finishedTable ? run.current_table_index + 1 : run.current_table_index, finishedTable ? 0 : lastRowid, startedAt, now, run.id),
      ]);
    } catch (error) {
      await env.FILES.delete(r2Key);
      throw error;
    }
    return backupSummary((await loadBackup(env.DB, run.id))!);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.slice(0, 1000) : 'backup step failed';
    await env.DB.prepare(`UPDATE backup_runs SET status='failed',error=?,updated_at=? WHERE id=?`).bind(message, now, run.id).run();
    return backupSummary((await loadBackup(env.DB, run.id))!);
  }
}
async function verifyBackup(env: WorkerBindings, backupId: string): Promise<BackupVerificationSummary | null> {
  const run = await loadBackup(env.DB, backupId);
  if (!run || run.status !== 'completed' || !run.manifest_key) return null;
  const missingObjects: string[] = [], mismatchedObjects: string[] = [];
  const manifestObject = await env.FILES.get(run.manifest_key);
  if (!manifestObject) missingObjects.push(run.manifest_key);
  const chunks = await env.DB.prepare(`SELECT r2_key,sha256 FROM backup_chunks WHERE backup_run_id=? ORDER BY table_name,chunk_index`).bind(run.id).all<{ r2_key: string; sha256: string }>();
  for (const chunk of chunks.results ?? []) {
    const object = await env.FILES.get(chunk.r2_key);
    if (!object) { missingObjects.push(chunk.r2_key); continue; }
    const bytes = await object.arrayBuffer();
    if (await sha256Hex(bytes) !== chunk.sha256) mismatchedObjects.push(chunk.r2_key);
  }
  const verified = missingObjects.length === 0 && mismatchedObjects.length === 0;
  const verifiedAt = verified ? new Date().toISOString() : null;
  if (verifiedAt) await env.DB.prepare(`UPDATE backup_runs SET verified_at=?,updated_at=? WHERE id=?`).bind(verifiedAt, verifiedAt, run.id).run();
  return { backupId: run.id, verified, missingObjects, mismatchedObjects, verifiedAt };
}
function shanghaiParts(nowIso: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowIso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return { businessDate: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
}
function isMonthEnd(date: string) { return date === monthEnd(date.slice(0, 7)); }
export async function runP6Tick(env: WorkerBindings, nowIso: string) {
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
  const pending = await env.DB.prepare(`SELECT id FROM backup_runs WHERE status IN ('pending','running') ORDER BY backup_date,kind,id LIMIT 1`).first<{ id: string }>();
  if (pending) await processBackupStep(env, pending.id);
  return { businessDate: local.businessDate, backupCreated, createdEvents: alerts.createdEvents, notificationDelivery, backupProcessed: pending?.id ?? null };
}

async function currentReserveRemaining(c: Context<AppEnv>): Promise<{ data: ReserveRemainingSummary | null; error: ApiError | null }> {
  const access = projectAccessFilter(c, 'p');
  const rows = await c.env.DB.prepare(
    `SELECT pmr.required_quantity_scaled,pmr.amount_fen,pmr.reserve_category_id,rc.category_key,rc.label
     FROM project_material_requirements pmr
     INNER JOIN projects p ON p.id=pmr.project_id
     LEFT JOIN reserve_categories rc ON rc.id=pmr.reserve_category_id
     WHERE pmr.active=1
       AND NOT EXISTS (SELECT 1 FROM project_releases pr WHERE pr.project_id=p.id)
       AND ${access.sql}
     ORDER BY pmr.project_id,pmr.id`,
  ).bind(...access.binds).all<{
    required_quantity_scaled: number;
    amount_fen: number | null;
    reserve_category_id: string | null;
    category_key: string | null;
    label: string | null;
  }>();

  let currentMaterialQuantity = 0n;
  let knownCurrentMaterialAmount = 0n;
  let unclassifiedCurrentMaterial = 0n;
  let missingPriceCount = 0;
  const categoryTotals = new Map<string, { categoryKey: string; label: string; amount: bigint }>();
  for (const row of rows.results ?? []) {
    currentMaterialQuantity += BigInt(Number(row.required_quantity_scaled));
    if (row.amount_fen === null) {
      missingPriceCount += 1;
      continue;
    }
    const amount = BigInt(Number(row.amount_fen));
    knownCurrentMaterialAmount += amount;
    if (!row.reserve_category_id || !row.category_key || !row.label) {
      unclassifiedCurrentMaterial += amount;
      continue;
    }
    const current = categoryTotals.get(row.reserve_category_id) ?? { categoryKey: row.category_key, label: row.label, amount: 0n };
    current.amount += amount;
    categoryTotals.set(row.reserve_category_id, current);
  }

  const releasedProject = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM projects p
     WHERE ${access.sql} AND EXISTS (SELECT 1 FROM project_releases pr WHERE pr.project_id=p.id)`,
  ).bind(...access.binds).first<{ count: number }>();
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
      releasedProjectCount: Number(releasedProject?.count ?? 0),
      unscopedCommonCostFen: 0,
      categories,
    },
    error: null,
  };
}

async function dashboardSummary(c: Context<AppEnv>, asOf: string): Promise<AnalysisDashboardSummary> {
  const access = projectAccessFilter(c, 'p');
  const projectCount = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM projects p WHERE ${access.sql}`).bind(...access.binds).first<{ count: number }>();
  const demandCount = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT pdl.demand_id) AS count
     FROM project_demand_links pdl INNER JOIN projects p ON p.id=pdl.project_id
     WHERE ${access.sql}`,
  ).bind(...access.binds).first<{ count: number }>();
  const unreleased = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM projects p
     WHERE ${access.sql}
       AND NOT EXISTS (SELECT 1 FROM project_releases pr WHERE pr.project_id=p.id)`,
  ).bind(...access.binds).first<{ count: number }>();
  const pendingSettlement = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM projects p
     WHERE ${access.sql}
       AND EXISTS (
         SELECT 1
         FROM project_tasks pt
         INNER JOIN task_implementation_records tir ON tir.task_id=pt.id
         WHERE pt.project_id=p.id
           AND NOT EXISTS (
             SELECT 1 FROM task_settlements ts
             WHERE ts.task_id=pt.id AND ts.final=1 AND ts.voided_at IS NULL
           )
       )`,
  ).bind(...access.binds).first<{ count: number }>();
  const activeRows = await c.env.DB.prepare(
    `SELECT ae.object_type,ae.object_id,am.project_id AS milestone_project_id
     FROM alert_events ae LEFT JOIN annual_milestones am ON ae.object_type='milestone' AND am.id=ae.object_id
     WHERE ae.state='active'`,
  ).all<{ object_type: string; object_id: string; milestone_project_id: string | null }>();
  let activeAlertCount = 0;
  for (const row of activeRows.results ?? []) {
    if (row.object_type === 'framework' && canFramework(c, row.object_id)) activeAlertCount += 1;
    else if (row.object_type === 'project' && canProject(c, row.object_id)) activeAlertCount += 1;
    else if (row.object_type === 'milestone' && (!row.milestone_project_id || canProject(c, row.milestone_project_id))) activeAlertCount += 1;
  }
  return {
    asOf,
    projectCount: Number(projectCount?.count ?? 0),
    demandCount: Number(demandCount?.count ?? 0),
    unreleasedProjectCount: Number(unreleased?.count ?? 0),
    pendingSettlementCount: Number(pendingSettlement?.count ?? 0),
    activeAlertCount,
  };
}

export const p6App = new Hono<AppEnv>();

p6App.get('/analysis/dashboard', async (c) => {
  const asOf = validDate(c.req.query('asOf')); if (!asOf) return c.json(apiError('INVALID_AS_OF', 'asOf 必须为有效日期'), 400);
  return c.json({ ok: true as const, data: await dashboardSummary(c, asOf) });
});

p6App.get('/analysis/reserve-remaining', async (c) => {
  const result = await currentReserveRemaining(c);
  if (result.error) return c.json(result.error, result.error.error.code === 'ANALYSIS_AMOUNT_OVERFLOW' ? 422 : 500);
  return c.json({ ok: true as const, data: result.data! });
});

p6App.get('/analysis/rules', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  const row = await currentRule(new SqlAnalysisRepository(database));
  if (!row) return c.json(apiError('ANALYSIS_RULE_MISSING', '分析规则未配置'), 500);
  return c.json({ ok: true as const, data: row });
});

p6App.put('/analysis/rules', requireRoles('admin'), async (c) => {
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

p6App.get('/analysis/plans', async (c) => {
  const frameworkId = cleanText(c.req.query('frameworkId')), year = Number(c.req.query('year'));
  if (!frameworkId || !Number.isInteger(year) || year < 2000 || year > 2200) return c.json(apiError('INVALID_QUERY', 'frameworkId 和 year 必须有效'), 400);
  if (!canFramework(c, frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该框架月计划'), 403);
  const { database } = createCloudflarePersistence(c.env);
  const items = await new SqlAnalysisRepository(database).listPlans(frameworkId, year);
  return c.json({ ok: true as const, data: { items } });
});

p6App.put('/analysis/plans/:projectId/:year/:month', requireRoles('admin','project_manager'), async (c) => {
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

p6App.get('/analysis/frameworks/:id/progress', async (c) => {
  const asOf = validDate(c.req.query('asOf')); if (!asOf) return c.json(apiError('INVALID_AS_OF', 'asOf 必须为有效日期'), 400);
  if (!canFramework(c, c.req.param('id'))) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该框架分析'), 403);
  const { database } = createCloudflarePersistence(c.env);
  const data = await frameworkProgress(new SqlAnalysisRepository(database), c.req.param('id'), asOf); if (!data) return c.json(apiError('NOT_FOUND', '框架不存在'), 404);
  return c.json({ ok: true as const, data });
});

p6App.get('/analysis/projects/gaps', async (c) => {
  const frameworkId = cleanText(c.req.query('frameworkId')), asOf = validDate(c.req.query('asOf'));
  if (!frameworkId || !asOf) return c.json(apiError('INVALID_QUERY', 'frameworkId 和 asOf 必须有效'), 400);
  if (!canFramework(c, frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该框架分析'), 403);
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await projectGaps(new SqlAnalysisRepository(database), frameworkId, asOf) } });
});

p6App.post('/reports/monthly', requireRoles('admin','project_manager'), async (c) => {
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

p6App.get('/reports/monthly', async (c) => {
  const frameworkId = cleanText(c.req.query('frameworkId')), businessMonth = validMonth(c.req.query('businessMonth'));
  if (!frameworkId || !businessMonth) return c.json(apiError('INVALID_QUERY', 'frameworkId 和 businessMonth 必须有效'), 400);
  if (!canFramework(c, frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该框架月报'), 403);
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlAnalysisRepository(database).listReports(frameworkId, businessMonth) } });
});

p6App.post('/milestones', requireRoles('admin','project_manager'), async (c) => {
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

p6App.get('/milestones', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  const items = (await new SqlAnalysisRepository(database).listMilestones()).filter((item) => !item.projectId || canProject(c, item.projectId));
  return c.json({ ok: true as const, data: { items } });
});

p6App.get('/milestones/due', async (c) => {
  const asOf = validDate(c.req.query('asOf')); if (!asOf) return c.json(apiError('INVALID_AS_OF', 'asOf 必须为有效日期'), 400);
  const { database } = createCloudflarePersistence(c.env);
  const items = (await new SqlAnalysisRepository(database).listMilestones()).filter((item) => !item.projectId || canProject(c, item.projectId)).map((item) => milestoneDue(item, asOf));
  return c.json({ ok: true as const, data: { items } });
});

p6App.put('/milestones/:id/status', requireRoles('admin','project_manager'), async (c) => {
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

p6App.post('/notification-contacts', requireRoles('admin'), async (c) => {
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

p6App.get('/notification-contacts', requireRoles('admin'), async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlNotificationRepository(database).listContacts() } });
});

p6App.post('/alerts/evaluate', requireRoles('admin','project_manager'), async (c) => {
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

p6App.get('/alerts', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlNotificationRepository(database).listAlerts(200) } });
});

p6App.get('/notification-outbox', requireRoles('admin'), async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlNotificationRepository(database).listOutbox(200) } });
});

p6App.post('/notification-outbox/claim', requireRoles('admin'), async (c) => {
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

p6App.post('/notification-outbox/:id/result', requireRoles('admin'), async (c) => {
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

p6App.post('/backups', requireRoles('admin'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const backupDate = validDate(body.backupDate), kind = cleanText(body.kind) as BackupKind;
  if (!backupDate || !['daily','monthly'].includes(kind)) return c.json(apiError('INVALID_BACKUP', '备份日期或类型无效'), 422);
  const request = { backupDate, kind }, hash = await requestHash(request), operation = `backups.create:${backupDate}:${kind}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const ensured = await ensureBackup(c.env, backupDate, kind), actor = c.get('currentUser'), now = new Date().toISOString(), response = { ok: true as const, data: ensured.backup };
  try { await c.env.DB.batch([auditStatement(c.env.DB, actor.id, 'backup.create', 'backup', ensured.backup.id, null, ensured.backup, now), idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, ensured.created ? 201 : 200, now)]); }
  catch { return c.json(apiError('BACKUP_CONFLICT', '备份创建记录冲突'), 409); }
  return c.json(response, ensured.created ? 201 : 200);
});

p6App.get('/backups', requireRoles('admin'), async (c) => {
  const result = await c.env.DB.prepare(`SELECT id,backup_date,kind,status,current_table_index,cursor_rowid,manifest_key,chunk_count,error,started_at,completed_at,verified_at,created_at,updated_at FROM backup_runs ORDER BY backup_date DESC,kind,id DESC LIMIT 100`).all<BackupRow>();
  return c.json({ ok: true as const, data: { items: (result.results ?? []).map(backupSummary) } });
});

p6App.post('/backups/:id/step', requireRoles('admin'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const hash = await requestHash({}), operation = `backups.step:${c.req.param('id')}:${key}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const data = await processBackupStep(c.env, c.req.param('id')); if (!data) return c.json(apiError('NOT_FOUND', '备份任务不存在'), 404);
  const actor = c.get('currentUser'), now = new Date().toISOString(), response = { ok: true as const, data };
  try { await c.env.DB.batch([auditStatement(c.env.DB, actor.id, 'backup.step', 'backup', data.id, null, { status: data.status, currentTableIndex: data.currentTableIndex, chunkCount: data.chunkCount }, now), idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, now)]); }
  catch { return c.json(apiError('BACKUP_STEP_CONFLICT', '备份步骤记录冲突'), 409); }
  return c.json(response);
});

p6App.post('/backups/:id/verify', requireRoles('admin'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const hash = await requestHash({}), operation = `backups.verify:${c.req.param('id')}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const data = await verifyBackup(c.env, c.req.param('id')); if (!data) return c.json(apiError('BACKUP_NOT_READY', '备份不存在或尚未完成'), 422);
  const actor = c.get('currentUser'), now = new Date().toISOString(), response = { ok: true as const, data };
  try { await c.env.DB.batch([auditStatement(c.env.DB, actor.id, 'backup.verify', 'backup', data.backupId, null, data, now), idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, now)]); }
  catch { return c.json(apiError('BACKUP_VERIFY_CONFLICT', '备份校验记录冲突'), 409); }
  return c.json(response);
});

p6App.post('/system/tasks/run', requireRoles('admin'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const nowInput = validIso(body.now); if (!nowInput) return c.json(apiError('INVALID_SCHEDULED_TIME', 'now 必须为有效 ISO 时间'), 422);
  const request = { now: nowInput }, hash = await requestHash(request), operation = `system.tasks.run:${nowInput}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const data = await runP6Tick(c.env, nowInput), actor = c.get('currentUser'), storedAt = new Date().toISOString(), response = { ok: true as const, data };
  try { await c.env.DB.batch([auditStatement(c.env.DB, actor.id, 'system.tasks.run', 'scheduled_tick', nowInput, null, data, storedAt), idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, storedAt)]); }
  catch { return c.json(apiError('TASK_RUN_CONFLICT', '后台任务运行记录冲突'), 409); }
  return c.json(response);
});
