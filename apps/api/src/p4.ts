import { Hono, type Context } from 'hono';
import type {
  AgreementStatus,
  AgreementSummary,
  ApiError,
  BindProjectFrameworkRequest,
  BudgetAllocationInput,
  BudgetAllocationSummary,
  BudgetVersionSummary,
  ConfirmBudgetRequest,
  CreateBudgetRequest,
  CreateFinancialEntryRequest,
  FinanceAgreementMetric,
  FinanceProjectSummary,
  FinancialEntryAllocationInput,
  FinancialEntryPage,
  FinancialEntrySummary,
  FinancialEntryType,
  FrameworkFinanceSummary,
  FrameworkSummary,
  ProjectBudgetSummary,
  UpdateBudgetRequest,
} from '@tpm/shared';
import { hasScope, requireRoles, type AppEnv } from './auth';
import { SqlFinanceQueryRepository } from './repositories/sql-finance-query-repository';
import { SqlFinanceWriteRepository } from './repositories/sql-finance-write-repository';
import { SqlIdempotencyRepository } from './repositories/sql-idempotency-repository';
import { createCloudflarePersistence } from './runtime/cloudflare/persistence';

const MAX_PAGE_SIZE = 100;

type FrameworkRow = {
  id: string; code: string; name: string; total_amount_fen: number; annual_target_fen: number | null;
  start_date: string; end_date: string; version: number; created_at: string; updated_at: string;
};
type AgreementRow = {
  id: string; framework_id: string; code: string; name: string; amount_fen: number; valid_from: string; valid_to: string;
  status: AgreementStatus; version: number; created_at: string; updated_at: string;
};
type ProjectRow = { id: string; name: string; framework_id: string | null; version: number };
type BudgetRow = {
  id: string; project_id: string; total_amount_fen: number; note: string | null; status: 'draft' | 'confirmed';
  budget_version: number; version: number; created_at: string; updated_at: string;
};
type AllocationRow = { agreement_id: string; amount_fen: number; code: string; name: string };
type FinancialEntryRow = {
  id: string; framework_id: string; project_id: string; project_name: string; entry_type: FinancialEntryType;
  business_date: string; amount_fen: number; note: string | null; reverses_entry_id: string | null; created_at: string;
};

function apiError(code: string, message: string, details?: unknown): ApiError {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}
function cleanText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}
function nullableText(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const text = cleanText(value);
  return text && text.length <= max ? text : undefined;
}
function safeNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function safePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function optionalSafeNonNegative(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const parsed = safeNonNegative(value);
  return parsed === null ? undefined : parsed;
}
function safeSum(values: number[]): number | null {
  let total = 0n;
  for (const value of values) total += BigInt(value);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) && total >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(total) : null;
}
function expectedVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}
function dateValue(value: unknown): string | null {
  const text = cleanText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function requireIdempotencyKey(c: Context<AppEnv>): string | Response {
  const key = c.req.header('Idempotency-Key')?.trim();
  if (!key || key.length > 200) return c.json(apiError('IDEMPOTENCY_KEY_REQUIRED', '变更请求必须提供有效的 Idempotency-Key'), 400);
  return key;
}
async function requestHash(value: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function replayIdempotentResponse(c: Context<AppEnv>, key: string, operation: string, hash: string) {
  const actor = c.get('currentUser');
  const { database } = createCloudflarePersistence(c.env);
  const row = await new SqlIdempotencyRepository(database).findByKey(key);
  if (!row) return null;
  if (row.actorMemberId !== actor.id || row.operation !== operation || row.requestHash !== hash) {
    return c.json(apiError('IDEMPOTENCY_CONFLICT', '该 Idempotency-Key 已用于不同请求'), 409);
  }
  return new Response(row.responseJson, { status: row.statusCode, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' } });
}
function idempotencyStatement(db: D1Database, key: string, actorId: string, operation: string, hash: string, response: unknown, statusCode: number, now: string) {
  return db.prepare(
    `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(key, actorId, operation, hash, JSON.stringify(response), statusCode, now);
}
function auditStatement(db: D1Database, actorId: string, action: string, objectType: string, objectId: string, before: unknown, after: unknown, now: string) {
  return db.prepare(
    `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(crypto.randomUUID(), actorId, action, objectType, objectId,
    before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), now);
}
function frameworkSummary(row: FrameworkRow): FrameworkSummary {
  return {
    id: row.id, code: row.code, name: row.name, totalAmountFen: row.total_amount_fen,
    annualTargetFen: row.annual_target_fen, startDate: row.start_date, endDate: row.end_date,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
async function findFramework(db: D1Database, id: string) {
  return db.prepare(`SELECT id,code,name,total_amount_fen,annual_target_fen,start_date,end_date,version,created_at,updated_at FROM frameworks WHERE id=? LIMIT 1`)
    .bind(id).first<FrameworkRow>();
}
async function findAgreement(db: D1Database, id: string) {
  return db.prepare(`SELECT id,framework_id,code,name,amount_fen,valid_from,valid_to,status,version,created_at,updated_at FROM agreements WHERE id=? LIMIT 1`)
    .bind(id).first<AgreementRow>();
}
async function findProject(db: D1Database, id: string) {
  return db.prepare(`SELECT id,name,framework_id,version FROM projects WHERE id=? LIMIT 1`).bind(id).first<ProjectRow>();
}
function canFramework(c: Context<AppEnv>, frameworkId: string) {
  const user = c.get('currentUser');
  return user.role === 'admin' || hasScope(user.scopes, 'framework', frameworkId);
}
function canProject(c: Context<AppEnv>, projectId: string) {
  const user = c.get('currentUser');
  return user.role === 'admin' || hasScope(user.scopes, 'project', projectId);
}
function hasGlobalScope(c: Context<AppEnv>) {
  const user = c.get('currentUser');
  return user.role === 'admin' || user.scopes.some((scope) => scope.type === 'all');
}
function budgetGuard(db: D1Database, id: string, version: number, values: { total: number; note: string | null; status: 'draft' | 'confirmed'; incrementBudgetVersion: boolean; now: string }) {
  return db.prepare(
    `UPDATE project_budgets SET total_amount_fen=?,note=?,status=?,budget_version=budget_version+?,version=version+1,
       updated_at=CASE WHEN version=? THEN ? ELSE NULL END WHERE id=?`,
  ).bind(values.total, values.note, values.status, values.incrementBudgetVersion ? 1 : 0, version, values.now, id);
}
function normalizeAllocations(value: unknown): BudgetAllocationInput[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const seen = new Set<string>();
  const out: BudgetAllocationInput[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as { agreementId?: unknown; amountFen?: unknown };
    const agreementId = cleanText(item.agreementId);
    const amountFen = safeNonNegative(item.amountFen);
    if (!agreementId || amountFen === null || seen.has(agreementId)) return null;
    seen.add(agreementId);
    out.push({ agreementId, amountFen });
  }
  return out;
}
function normalizeEntryAllocations(value: unknown): FinancialEntryAllocationInput[] | null {
  const base = normalizeAllocations(value);
  if (!base) return null;
  return base.map((item) => ({ agreementId: item.agreementId, amountFen: item.amountFen }));
}
async function validateAgreementAllocations(db: D1Database, frameworkId: string, allocations: BudgetAllocationInput[], effectiveDate: string | null, requireActive: boolean) {
  const summaries: BudgetAllocationSummary[] = [];
  for (const item of allocations) {
    const agreement = await findAgreement(db, item.agreementId);
    if (!agreement) return { error: apiError('AGREEMENT_NOT_FOUND', '协议不存在') };
    if (agreement.framework_id !== frameworkId) return { error: apiError('AGREEMENT_FRAMEWORK_MISMATCH', '协议与项目不属于同一框架') };
    if (requireActive && (agreement.status !== 'active' || (effectiveDate !== null && (effectiveDate < agreement.valid_from || effectiveDate > agreement.valid_to)))) {
      return { error: apiError('AGREEMENT_NOT_EFFECTIVE', '协议在业务日期不是有效状态') };
    }
    summaries.push({ agreementId: agreement.id, amountFen: item.amountFen, agreementCode: agreement.code, agreementName: agreement.name });
  }
  return { summaries };
}
async function loadBudgetAllocations(db: D1Database, budgetId: string): Promise<BudgetAllocationSummary[]> {
  const result = await db.prepare(
    `SELECT ba.agreement_id,ba.amount_fen,a.code,a.name FROM budget_allocations ba INNER JOIN agreements a ON a.id=ba.agreement_id
     WHERE ba.budget_id=? ORDER BY a.code COLLATE NOCASE,a.id`,
  ).bind(budgetId).all<AllocationRow>();
  return (result.results ?? []).map((row) => ({ agreementId: row.agreement_id, amountFen: row.amount_fen, agreementCode: row.code, agreementName: row.name }));
}
async function loadBudget(db: D1Database, id: string): Promise<ProjectBudgetSummary | null> {
  const row = await db.prepare(
    `SELECT pb.id,pb.project_id,pb.total_amount_fen,pb.note,pb.status,pb.budget_version,pb.version,pb.created_at,pb.updated_at,
            p.name AS project_name,p.framework_id
     FROM project_budgets pb INNER JOIN projects p ON p.id=pb.project_id WHERE pb.id=? LIMIT 1`,
  ).bind(id).first<BudgetRow & { project_name: string; framework_id: string | null }>();
  if (!row) return null;
  return {
    id: row.id, projectId: row.project_id, projectName: row.project_name, frameworkId: row.framework_id,
    totalAmountFen: row.total_amount_fen, note: row.note, status: row.status, budgetVersion: row.budget_version,
    version: row.version, allocations: await loadBudgetAllocations(db, row.id), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function basisPoints(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  const value = (BigInt(numerator) * 10000n + BigInt(Math.floor(denominator / 2))) / BigInt(denominator);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}
function ratioAtLeast(numerator: number, denominator: number, thresholdBasisPoints: number) {
  return denominator > 0 && BigInt(numerator) * 10000n >= BigInt(denominator) * BigInt(thresholdBasisPoints);
}
function parseSqlSafeInteger(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null;
  const integer = BigInt(value);
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) && integer >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(integer) : null;
}
function makeEntryCursor(businessDate: string, createdAt: string, id: string) {
  return btoa(JSON.stringify({ businessDate, createdAt, id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function parseEntryCursor(value: string | undefined): { businessDate: string; createdAt: string; id: string } | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    if (typeof decoded.businessDate !== 'string' || typeof decoded.createdAt !== 'string' || typeof decoded.id !== 'string') return null;
    return { businessDate: decoded.businessDate, createdAt: decoded.createdAt, id: decoded.id };
  } catch { return null; }
}

export const p4App = new Hono<AppEnv>();

p4App.get('/finance/projects', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  const items: FinanceProjectSummary[] = (await new SqlFinanceQueryRepository(database).listProjects())
    .filter((row) => canProject(c, row.id) || (row.frameworkId !== null && canFramework(c, row.frameworkId)));
  return c.json({ ok: true as const, data: { items } });
});

p4App.get('/frameworks', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  const items = (await new SqlFinanceQueryRepository(database).listFrameworks()).filter((row) => canFramework(c, row.id));
  return c.json({ ok: true as const, data: { items } });
});

p4App.post('/frameworks', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  if (!hasGlobalScope(c)) return c.json(apiError('SCOPE_FORBIDDEN', '创建框架需要全部业务范围'), 403);
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const code = cleanText(body.code), name = cleanText(body.name), total = safeNonNegative(body.totalAmountFen);
  const annual = optionalSafeNonNegative(body.annualTargetFen);
  const start = dateValue(body.startDate), end = dateValue(body.endDate);
  if (!code || code.length > 80 || !name || name.length > 120 || total === null || annual === undefined || !start || !end || start > end) return c.json(apiError('INVALID_FRAMEWORK', '框架编号、名称、金额或期间无效'), 422);
  const request = { code, name, totalAmountFen: total, annualTargetFen: annual, startDate: start, endDate: end };
  const hash = await requestHash(request), operation = 'frameworks.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), id = crypto.randomUUID(), now = new Date().toISOString();
  const data: FrameworkSummary = { id, ...request, version: 1, createdAt: now, updatedAt: now };
  const response = { ok: true as const, data };
  const { database } = createCloudflarePersistence(c.env);
  try {
    await new SqlFinanceWriteRepository(database).createFramework({
      framework: data,
      versionId: crypto.randomUUID(),
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch { return c.json(apiError('FRAMEWORK_CONFLICT', '框架编号已存在或数据冲突'), 409); }
  return c.json(response, 201);
});

p4App.put('/frameworks/:id', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const { database } = createCloudflarePersistence(c.env);
  const queryRepository = new SqlFinanceQueryRepository(database);
  const current = await queryRepository.findFramework(c.req.param('id')); if (!current) return c.json(apiError('NOT_FOUND', '框架不存在'), 404);
  if (!canFramework(c, current.id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权修改该框架'), 403);
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion), name = cleanText(body.name), total = safeNonNegative(body.totalAmountFen);
  const annual = optionalSafeNonNegative(body.annualTargetFen);
  const start = dateValue(body.startDate), end = dateValue(body.endDate), reason = nullableText(body.reason, 500);
  if (version === null || !name || name.length > 120 || total === null || annual === undefined || !start || !end || start > end || reason === undefined) return c.json(apiError('INVALID_FRAMEWORK', '框架更新参数无效'), 422);
  const request = { expectedVersion: version, name, totalAmountFen: total, annualTargetFen: annual, startDate: start, endDate: end, reason };
  const hash = await requestHash(request), operation = `frameworks.update:${current.id}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (current.version !== version) return c.json(apiError('VERSION_CONFLICT', '框架已被修改，请刷新后重试'), 409);
  const actor = c.get('currentUser'), now = new Date().toISOString(), next = version + 1;
  const data: FrameworkSummary = { id: current.id, code: current.code, name, totalAmountFen: total, annualTargetFen: annual, startDate: start, endDate: end, version: next, createdAt: current.createdAt, updatedAt: now };
  const response = { ok: true as const, data };
  try {
    await new SqlFinanceWriteRepository(database).updateFramework({
      before: current,
      next: data,
      expectedVersion: version,
      reason,
      versionId: crypto.randomUUID(),
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    const latest = await queryRepository.findFramework(current.id);
    if (latest && latest.version !== version) return c.json(apiError('VERSION_CONFLICT', '框架已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('FRAMEWORK_CONFLICT', '框架更新失败'), 409);
  }
  return c.json(response);
});

p4App.get('/frameworks/:id/history', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlFinanceQueryRepository(database);
  const current = await repository.findFramework(c.req.param('id')); if (!current) return c.json(apiError('NOT_FOUND', '框架不存在'), 404);
  if (!canFramework(c, current.id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该框架'), 403);
  const items = await repository.getFrameworkHistory(current.id);
  return c.json({ ok: true as const, data: { items: items ?? [] } });
});

p4App.get('/agreements', async (c) => {
  const frameworkId = cleanText(c.req.query('frameworkId'));
  if (frameworkId && !canFramework(c, frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该框架协议'), 403);
  const { database } = createCloudflarePersistence(c.env);
  const items = (await new SqlFinanceQueryRepository(database).listAgreements(frameworkId || null))
    .filter((row) => canFramework(c, row.frameworkId));
  return c.json({ ok: true as const, data: { items } });
});

p4App.post('/agreements', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const frameworkId = cleanText(body.frameworkId), code = cleanText(body.code), name = cleanText(body.name), amount = safeNonNegative(body.amountFen);
  const from = dateValue(body.validFrom), to = dateValue(body.validTo), status = cleanText(body.status) as AgreementStatus;
  if (!frameworkId || !code || code.length > 80 || !name || name.length > 120 || amount === null || !from || !to || from > to || !['active','paused','expired'].includes(status)) return c.json(apiError('INVALID_AGREEMENT', '协议参数无效'), 422);
  const { database } = createCloudflarePersistence(c.env);
  const queryRepository = new SqlFinanceQueryRepository(database);
  const framework = await queryRepository.findFramework(frameworkId); if (!framework) return c.json(apiError('FRAMEWORK_NOT_FOUND', '框架不存在'), 422);
  if (!canFramework(c, frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权管理该框架协议'), 403);
  const request = { frameworkId, code, name, amountFen: amount, validFrom: from, validTo: to, status };
  const hash = await requestHash(request), operation = 'agreements.create'; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), id = crypto.randomUUID(), now = new Date().toISOString();
  const data: AgreementSummary = { id, ...request, version: 1, createdAt: now, updatedAt: now };
  const response = { ok: true as const, data };
  try {
    await new SqlFinanceWriteRepository(database).createAgreement({
      agreement: data,
      versionId: crypto.randomUUID(),
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch { return c.json(apiError('AGREEMENT_CONFLICT', '协议编号已存在或数据冲突'), 409); }
  return c.json(response, 201);
});

p4App.put('/agreements/:id', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const { database } = createCloudflarePersistence(c.env);
  const queryRepository = new SqlFinanceQueryRepository(database);
  const current = await queryRepository.findAgreement(c.req.param('id')); if (!current) return c.json(apiError('NOT_FOUND', '协议不存在'), 404);
  if (!canFramework(c, current.frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权修改该协议'), 403);
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion), name = cleanText(body.name), amount = safeNonNegative(body.amountFen);
  const from = dateValue(body.validFrom), to = dateValue(body.validTo), status = cleanText(body.status) as AgreementStatus, reason = nullableText(body.reason, 500);
  if (version === null || !name || amount === null || !from || !to || from > to || !['active','paused','expired'].includes(status) || reason === undefined) return c.json(apiError('INVALID_AGREEMENT', '协议更新参数无效'), 422);
  const request = { expectedVersion: version, name, amountFen: amount, validFrom: from, validTo: to, status, reason };
  const hash = await requestHash(request), operation = `agreements.update:${current.id}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (current.version !== version) return c.json(apiError('VERSION_CONFLICT', '协议已被修改，请刷新后重试'), 409);
  const actor = c.get('currentUser'), now = new Date().toISOString(), next = version + 1;
  const data: AgreementSummary = { id: current.id, frameworkId: current.frameworkId, code: current.code, name, amountFen: amount, validFrom: from, validTo: to, status, version: next, createdAt: current.createdAt, updatedAt: now };
  const response = { ok: true as const, data };
  try {
    await new SqlFinanceWriteRepository(database).updateAgreement({
      before: current,
      next: data,
      expectedVersion: version,
      reason,
      versionId: crypto.randomUUID(),
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    const latest = await queryRepository.findAgreement(current.id);
    if (latest && latest.version !== version) return c.json(apiError('VERSION_CONFLICT', '协议已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('AGREEMENT_CONFLICT', '协议更新失败'), 409);
  }
  return c.json(response);
});

p4App.get('/agreements/:id/history', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlFinanceQueryRepository(database);
  const current = await repository.findAgreement(c.req.param('id')); if (!current) return c.json(apiError('NOT_FOUND', '协议不存在'), 404);
  if (!canFramework(c, current.frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该协议'), 403);
  const items = await repository.getAgreementHistory(current.id);
  return c.json({ ok: true as const, data: { items: items ?? [] } });
});

p4App.put('/projects/:id/framework', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const { database } = createCloudflarePersistence(c.env);
  const queryRepository = new SqlFinanceQueryRepository(database);
  const writeRepository = new SqlFinanceWriteRepository(database);
  const project = await queryRepository.findProject(c.req.param('id')); if (!project) return c.json(apiError('NOT_FOUND', '项目不存在'), 404);
  if (!canProject(c, project.id) && !hasGlobalScope(c)) return c.json(apiError('SCOPE_FORBIDDEN', '无权修改该项目'), 403);
  let body: Partial<BindProjectFrameworkRequest>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion), frameworkId = cleanText(body.frameworkId);
  if (version === null || !frameworkId) return c.json(apiError('INVALID_BINDING', 'expectedVersion 或 frameworkId 无效'), 422);
  const request = { expectedVersion: version, frameworkId }; const hash = await requestHash(request), operation = `projects.framework:${project.id}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (project.version !== version) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const framework = await queryRepository.findFramework(frameworkId); if (!framework) return c.json(apiError('FRAMEWORK_NOT_FOUND', '框架不存在'), 422);
  if (!canFramework(c, frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权使用目标框架'), 403);
  if (project.frameworkId && project.frameworkId !== frameworkId && await queryRepository.hasProjectFinanceHistory(project.id)) {
    return c.json(apiError('FRAMEWORK_CHANGE_BLOCKED', '项目已有确认预算或资金流水，不能直接改绑框架'), 422);
  }
  const actor = c.get('currentUser'), now = new Date().toISOString(), data = { projectId: project.id, frameworkId, version: version + 1 };
  const response = { ok: true as const, data };
  try {
    await writeRepository.bindProjectFramework({
      projectId: project.id,
      beforeFrameworkId: project.frameworkId,
      frameworkId,
      expectedVersion: version,
      nextVersion: version + 1,
      now,
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    const latest = await queryRepository.findProject(project.id); if (latest && latest.version !== version) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('FRAMEWORK_BIND_CONFLICT', '项目框架绑定失败'), 409);
  }
  return c.json(response);
});

p4App.get('/budgets', async (c) => {
  const projectId = cleanText(c.req.query('projectId'));
  const result = projectId
    ? await c.env.DB.prepare(`SELECT id FROM project_budgets WHERE project_id=? LIMIT 100`).bind(projectId).all<{ id: string }>()
    : await c.env.DB.prepare(`SELECT id FROM project_budgets ORDER BY updated_at DESC,id DESC LIMIT 100`).all<{ id: string }>();
  const items: ProjectBudgetSummary[] = [];
  for (const row of result.results ?? []) {
    const budget = await loadBudget(c.env.DB, row.id); if (!budget) continue;
    if (canProject(c, budget.projectId) || (budget.frameworkId && canFramework(c, budget.frameworkId))) items.push(budget);
  }
  return c.json({ ok: true as const, data: { items } });
});

p4App.post('/budgets', requireRoles('admin', 'project_manager', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Partial<CreateBudgetRequest>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const projectId = cleanText(body.projectId), total = safeNonNegative(body.totalAmountFen), allocations = normalizeAllocations(body.allocations), note = nullableText(body.note, 1000);
  if (!projectId || total === null || !allocations || note === undefined) return c.json(apiError('INVALID_BUDGET', '预算参数无效'), 422);
  const project = await findProject(c.env.DB, projectId); if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 422);
  if (!canProject(c, projectId) && !(project.framework_id && canFramework(c, project.framework_id))) return c.json(apiError('SCOPE_FORBIDDEN', '无权管理该项目预算'), 403);
  if (allocations.length && !project.framework_id) return c.json(apiError('PROJECT_FRAMEWORK_REQUIRED', '项目未归属框架，不能分配协议'), 422);
  let summaries: BudgetAllocationSummary[] = [];
  if (project.framework_id) {
    const checked = await validateAgreementAllocations(c.env.DB, project.framework_id, allocations, null, false);
    if (checked.error) return c.json(checked.error, 422); summaries = checked.summaries ?? [];
  }
  const request: CreateBudgetRequest = { projectId, totalAmountFen: total, allocations, note };
  const hash = await requestHash(request), operation = 'budgets.create'; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), id = crypto.randomUUID(), now = new Date().toISOString();
  const data: ProjectBudgetSummary = { id, projectId, projectName: project.name, frameworkId: project.framework_id, totalAmountFen: total, note, status: 'draft', budgetVersion: 0, version: 1, allocations: summaries, createdAt: now, updatedAt: now };
  const response = { ok: true as const, data };
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`INSERT INTO project_budgets (id,project_id,total_amount_fen,note,status,budget_version,version,created_by,created_at,updated_at) VALUES (?,?,?,?,'draft',0,1,?,?,?)`).bind(id, projectId, total, note, actor.id, now, now),
    ...allocations.map((item) => c.env.DB.prepare(`INSERT INTO budget_allocations (id,budget_id,agreement_id,amount_fen,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), id, item.agreementId, item.amountFen, now)),
    auditStatement(c.env.DB, actor.id, 'budget.create', 'budget', id, null, data, now),
    idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 201, now),
  ];
  try { await c.env.DB.batch(statements); } catch { return c.json(apiError('BUDGET_CONFLICT', '项目预算已存在或数据冲突'), 409); }
  return c.json(response, 201);
});

p4App.put('/budgets/:id', requireRoles('admin', 'project_manager', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const current = await loadBudget(c.env.DB, c.req.param('id')); if (!current) return c.json(apiError('NOT_FOUND', '预算不存在'), 404);
  if (!canProject(c, current.projectId) && !(current.frameworkId && canFramework(c, current.frameworkId))) return c.json(apiError('SCOPE_FORBIDDEN', '无权修改该预算'), 403);
  let body: Partial<UpdateBudgetRequest>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion), total = safeNonNegative(body.totalAmountFen), allocations = normalizeAllocations(body.allocations), note = nullableText(body.note, 1000);
  if (version === null || total === null || !allocations || note === undefined) return c.json(apiError('INVALID_BUDGET', '预算更新参数无效'), 422);
  const request: UpdateBudgetRequest = { expectedVersion: version, totalAmountFen: total, allocations, note };
  const hash = await requestHash(request), operation = `budgets.update:${current.id}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (current.version !== version) return c.json(apiError('VERSION_CONFLICT', '预算已被修改，请刷新后重试'), 409);
  const project = await findProject(c.env.DB, current.projectId); if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 422);
  if (allocations.length && !project.framework_id) return c.json(apiError('PROJECT_FRAMEWORK_REQUIRED', '项目未归属框架，不能分配协议'), 422);
  let summaries: BudgetAllocationSummary[] = [];
  if (project.framework_id) { const checked = await validateAgreementAllocations(c.env.DB, project.framework_id, allocations, null, false); if (checked.error) return c.json(checked.error, 422); summaries = checked.summaries ?? []; }
  const actor = c.get('currentUser'), now = new Date().toISOString();
  const data: ProjectBudgetSummary = { ...current, frameworkId: project.framework_id, totalAmountFen: total, note, status: 'draft', version: version + 1, allocations: summaries, updatedAt: now };
  const response = { ok: true as const, data };
  const statements: D1PreparedStatement[] = [
    budgetGuard(c.env.DB, current.id, version, { total, note, status: 'draft', incrementBudgetVersion: false, now }),
    c.env.DB.prepare(`DELETE FROM budget_allocations WHERE budget_id=?`).bind(current.id),
    ...allocations.map((item) => c.env.DB.prepare(`INSERT INTO budget_allocations (id,budget_id,agreement_id,amount_fen,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), current.id, item.agreementId, item.amountFen, now)),
    auditStatement(c.env.DB, actor.id, 'budget.update', 'budget', current.id, { version, totalAmountFen: current.totalAmountFen }, data, now),
    idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, now),
  ];
  try { await c.env.DB.batch(statements); } catch {
    const latest = await loadBudget(c.env.DB, current.id); if (latest && latest.version !== version) return c.json(apiError('VERSION_CONFLICT', '预算已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('BUDGET_CONFLICT', '预算更新失败'), 409);
  }
  return c.json(response);
});

p4App.post('/budgets/:id/confirm', requireRoles('admin', 'project_manager', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const current = await loadBudget(c.env.DB, c.req.param('id')); if (!current) return c.json(apiError('NOT_FOUND', '预算不存在'), 404);
  if (!canProject(c, current.projectId) && !(current.frameworkId && canFramework(c, current.frameworkId))) return c.json(apiError('SCOPE_FORBIDDEN', '无权确认该预算'), 403);
  let body: Partial<ConfirmBudgetRequest>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion); if (version === null) return c.json(apiError('INVALID_VERSION', 'expectedVersion 无效'), 422);
  const request = { expectedVersion: version }; const hash = await requestHash(request), operation = `budgets.confirm:${current.id}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (current.version !== version) return c.json(apiError('VERSION_CONFLICT', '预算已被修改，请刷新后重试'), 409);
  const project = await findProject(c.env.DB, current.projectId); if (!project?.framework_id) return c.json(apiError('PROJECT_FRAMEWORK_REQUIRED', '确认预算前项目必须归属框架'), 422);
  const sum = safeSum(current.allocations.map((item) => item.amountFen));
  if (!current.allocations.length || sum === null || sum !== current.totalAmountFen) return c.json(apiError('BUDGET_ALLOCATION_MISMATCH', '确认预算时协议分配合计必须精确等于预算总额'), 422);
  const checked = await validateAgreementAllocations(c.env.DB, project.framework_id, current.allocations, today(), true); if (checked.error) return c.json(checked.error, 422);
  const actor = c.get('currentUser'), now = new Date().toISOString(), budgetVersion = current.budgetVersion + 1, versionId = crypto.randomUUID();
  const data: ProjectBudgetSummary = { ...current, frameworkId: project.framework_id, status: 'confirmed', budgetVersion, version: version + 1, updatedAt: now };
  const response = { ok: true as const, data };
  const statements: D1PreparedStatement[] = [
    budgetGuard(c.env.DB, current.id, version, { total: current.totalAmountFen, note: current.note, status: 'confirmed', incrementBudgetVersion: true, now }),
    c.env.DB.prepare(`INSERT INTO budget_versions (id,budget_id,project_id,framework_id,budget_version,total_amount_fen,note,confirmed_by,confirmed_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(versionId, current.id, current.projectId, project.framework_id, budgetVersion, current.totalAmountFen, current.note, actor.id, now),
    ...current.allocations.map((item) => c.env.DB.prepare(`INSERT INTO budget_version_allocations (id,budget_version_id,agreement_id,amount_fen,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), versionId, item.agreementId, item.amountFen, now)),
    auditStatement(c.env.DB, actor.id, 'budget.confirm', 'budget', current.id, { version, budgetVersion: current.budgetVersion }, { version: version + 1, budgetVersion }, now),
    idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, now),
  ];
  try { await c.env.DB.batch(statements); } catch {
    const latest = await loadBudget(c.env.DB, current.id); if (latest && latest.version !== version) return c.json(apiError('VERSION_CONFLICT', '预算已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('BUDGET_CONFIRM_CONFLICT', '预算确认失败'), 409);
  }
  return c.json(response);
});

p4App.get('/budgets/:id/history', async (c) => {
  const budget = await loadBudget(c.env.DB, c.req.param('id')); if (!budget) return c.json(apiError('NOT_FOUND', '预算不存在'), 404);
  if (!canProject(c, budget.projectId) && !(budget.frameworkId && canFramework(c, budget.frameworkId))) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该预算'), 403);
  const rows = await c.env.DB.prepare(`SELECT id,budget_id,project_id,framework_id,budget_version,total_amount_fen,note,confirmed_at FROM budget_versions WHERE budget_id=? ORDER BY budget_version DESC`).bind(budget.id).all<any>();
  const items: BudgetVersionSummary[] = [];
  for (const row of rows.results ?? []) {
    const allocations = await c.env.DB.prepare(`SELECT bva.agreement_id,bva.amount_fen,a.code,a.name FROM budget_version_allocations bva INNER JOIN agreements a ON a.id=bva.agreement_id WHERE bva.budget_version_id=? ORDER BY a.code`).bind(row.id).all<AllocationRow>();
    items.push({ id: row.id, budgetId: row.budget_id, projectId: row.project_id, frameworkId: row.framework_id, budgetVersion: row.budget_version, totalAmountFen: row.total_amount_fen, note: row.note, confirmedAt: row.confirmed_at, allocations: (allocations.results ?? []).map((item) => ({ agreementId: item.agreement_id, amountFen: item.amount_fen, agreementCode: item.code, agreementName: item.name })) });
  }
  return c.json({ ok: true as const, data: { items } });
});

async function entrySummaries(db: D1Database, rows: FinancialEntryRow[]): Promise<FinancialEntrySummary[]> {
  if (!rows.length) return [];
  const placeholders = rows.map(() => '?').join(',');
  const allocationResult = await db.prepare(
    `SELECT fea.financial_entry_id,fea.agreement_id,fea.amount_fen,a.code,a.name
     FROM financial_entry_allocations fea INNER JOIN agreements a ON a.id=fea.agreement_id
     WHERE fea.financial_entry_id IN (${placeholders})
     ORDER BY fea.financial_entry_id,a.code COLLATE NOCASE,a.id`,
  ).bind(...rows.map((row) => row.id)).all<AllocationRow & { financial_entry_id: string }>();
  const allocations = new Map<string, BudgetAllocationSummary[]>();
  for (const item of allocationResult.results ?? []) {
    const list = allocations.get(item.financial_entry_id) ?? [];
    list.push({ agreementId: item.agreement_id, amountFen: item.amount_fen, agreementCode: item.code, agreementName: item.name });
    allocations.set(item.financial_entry_id, list);
  }
  return rows.map((row) => ({
    id: row.id,
    frameworkId: row.framework_id,
    projectId: row.project_id,
    projectName: row.project_name,
    type: row.entry_type,
    businessDate: row.business_date,
    amountFen: row.amount_fen,
    note: row.note,
    reversesEntryId: row.reverses_entry_id,
    allocations: allocations.get(row.id) ?? [],
    createdAt: row.created_at,
  }));
}

p4App.get('/financial-entries', async (c) => {
  const frameworkId = cleanText(c.req.query('frameworkId')), projectId = cleanText(c.req.query('projectId'));
  const limit = Number(c.req.query('limit') ?? '50');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return c.json(apiError('INVALID_PAGE_LIMIT', 'limit 必须在 1 到 100 之间'), 400);
  const cursorParam = c.req.query('cursor');
  const cursor = parseEntryCursor(cursorParam);
  if (cursorParam && !cursor) return c.json(apiError('INVALID_CURSOR', '资金流水分页游标无效'), 400);
  if (frameworkId && !canFramework(c, frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该框架流水'), 403);
  if (projectId && !canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目流水'), 403);
  const result = await c.env.DB.prepare(
    `SELECT fe.id,fe.framework_id,fe.project_id,p.name AS project_name,fe.entry_type,fe.business_date,fe.amount_fen,fe.note,fe.reverses_entry_id,fe.created_at
     FROM financial_entries fe INNER JOIN projects p ON p.id=fe.project_id
     WHERE (?='' OR fe.framework_id=?)
       AND (?='' OR fe.project_id=?)
       AND (? IS NULL OR fe.business_date < ?
         OR (fe.business_date = ? AND fe.created_at < ?)
         OR (fe.business_date = ? AND fe.created_at = ? AND fe.id < ?))
     ORDER BY fe.business_date DESC,fe.created_at DESC,fe.id DESC LIMIT ?`,
  ).bind(
    frameworkId, frameworkId, projectId, projectId,
    cursor?.businessDate ?? null,
    cursor?.businessDate ?? '', cursor?.businessDate ?? '', cursor?.createdAt ?? '',
    cursor?.businessDate ?? '', cursor?.createdAt ?? '', cursor?.id ?? '',
    limit + 1,
  ).all<FinancialEntryRow>();
  const visible = (result.results ?? []).filter((row) => canProject(c, row.project_id) || canFramework(c, row.framework_id));
  const pageRows = visible.slice(0, limit);
  const last = pageRows.at(-1);
  const data: FinancialEntryPage = {
    items: await entrySummaries(c.env.DB, pageRows),
    nextCursor: visible.length > limit && last ? makeEntryCursor(last.business_date, last.created_at, last.id) : null,
  };
  return c.json({ ok: true as const, data });
});

p4App.post('/financial-entries', requireRoles('admin', 'project_manager', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Partial<CreateFinancialEntryRequest>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const type = cleanText(body.type) as FinancialEntryType, projectId = cleanText(body.projectId), amount = safePositive(body.amountFen), businessDate = dateValue(body.businessDate), allocations = normalizeEntryAllocations(body.allocations), note = nullableText(body.note, 1000);
  if (!['budget_occurrence','actual_cost'].includes(type) || !projectId || amount === null || !businessDate || !allocations || note === undefined) return c.json(apiError('INVALID_FINANCIAL_ENTRY', '资金流水参数无效'), 422);
  const project = await findProject(c.env.DB, projectId); if (!project?.framework_id) return c.json(apiError('PROJECT_FRAMEWORK_REQUIRED', '登记资金流水前项目必须归属框架'), 422);
  if (!canProject(c, projectId) && !canFramework(c, project.framework_id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权登记该项目资金流水'), 403);
  const sum = safeSum(allocations.map((item) => item.amountFen));
  if (!allocations.length || sum === null || sum !== amount) return c.json(apiError('ENTRY_ALLOCATION_MISMATCH', '协议分配合计必须精确等于流水金额'), 422);
  const checked = await validateAgreementAllocations(c.env.DB, project.framework_id, allocations, businessDate, true); if (checked.error) return c.json(checked.error, 422);
  const request: CreateFinancialEntryRequest = { type, projectId, amountFen: amount, businessDate, allocations, note };
  const hash = await requestHash(request), operation = 'financial-entries.create'; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), id = crypto.randomUUID(), now = new Date().toISOString();
  const data: FinancialEntrySummary = { id, frameworkId: project.framework_id, projectId, projectName: project.name, type, businessDate, amountFen: amount, note, reversesEntryId: null, allocations: checked.summaries ?? [], createdAt: now };
  const response = { ok: true as const, data };
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`INSERT INTO financial_entries (id,framework_id,project_id,entry_type,business_date,amount_fen,note,reverses_entry_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,NULL,?,?)`).bind(id, project.framework_id, projectId, type, businessDate, amount, note, actor.id, now),
    ...allocations.map((item) => c.env.DB.prepare(`INSERT INTO financial_entry_allocations (id,financial_entry_id,agreement_id,amount_fen,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), id, item.agreementId, item.amountFen, now)),
    auditStatement(c.env.DB, actor.id, 'financial-entry.create', 'financial_entry', id, null, data, now),
    idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 201, now),
  ];
  try { await c.env.DB.batch(statements); } catch { return c.json(apiError('ENTRY_CONFLICT', '资金流水写入失败'), 409); }
  return c.json(response, 201);
});

p4App.post('/financial-entries/:id/reverse', requireRoles('admin', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const original = await c.env.DB.prepare(
    `SELECT fe.id,fe.framework_id,fe.project_id,p.name AS project_name,fe.entry_type,fe.business_date,fe.amount_fen,fe.note,fe.reverses_entry_id,fe.created_at
     FROM financial_entries fe INNER JOIN projects p ON p.id=fe.project_id WHERE fe.id=? LIMIT 1`,
  ).bind(c.req.param('id')).first<FinancialEntryRow>();
  if (!original) return c.json(apiError('NOT_FOUND', '资金流水不存在'), 404);
  if (original.reverses_entry_id || original.amount_fen < 0) return c.json(apiError('ENTRY_NOT_REVERSIBLE', '冲销记录不能再次冲销'), 422);
  if (!canProject(c, original.project_id) && !canFramework(c, original.framework_id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权冲销该流水'), 403);
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const businessDate = dateValue(body.businessDate), reason = nullableText(body.reason, 1000);
  if (!businessDate || !reason) return c.json(apiError('INVALID_REVERSAL', '冲销日期和原因不能为空'), 422);
  const request = { businessDate, reason }; const hash = await requestHash(request), operation = `financial-entries.reverse:${original.id}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const existing = await c.env.DB.prepare(`SELECT id FROM financial_entries WHERE reverses_entry_id=? LIMIT 1`).bind(original.id).first<{ id: string }>();
  if (existing) return c.json(apiError('ENTRY_ALREADY_REVERSED', '该流水已被冲销'), 409);
  const originalAllocations = await c.env.DB.prepare(`SELECT fea.agreement_id,fea.amount_fen,a.code,a.name FROM financial_entry_allocations fea INNER JOIN agreements a ON a.id=fea.agreement_id WHERE fea.financial_entry_id=? ORDER BY a.code`).bind(original.id).all<AllocationRow>();
  const actor = c.get('currentUser'), id = crypto.randomUUID(), now = new Date().toISOString();
  const allocations = (originalAllocations.results ?? []).map((item) => ({ agreementId: item.agreement_id, amountFen: -item.amount_fen, agreementCode: item.code, agreementName: item.name }));
  const data: FinancialEntrySummary = { id, frameworkId: original.framework_id, projectId: original.project_id, projectName: original.project_name, type: original.entry_type, businessDate, amountFen: -original.amount_fen, note: reason, reversesEntryId: original.id, allocations, createdAt: now };
  const response = { ok: true as const, data };
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`INSERT INTO financial_entries (id,framework_id,project_id,entry_type,business_date,amount_fen,note,reverses_entry_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id, original.framework_id, original.project_id, original.entry_type, businessDate, -original.amount_fen, reason, original.id, actor.id, now),
    ...(originalAllocations.results ?? []).map((item) => c.env.DB.prepare(`INSERT INTO financial_entry_allocations (id,financial_entry_id,agreement_id,amount_fen,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), id, item.agreement_id, -item.amount_fen, now)),
    auditStatement(c.env.DB, actor.id, 'financial-entry.reverse', 'financial_entry', original.id, { amountFen: original.amount_fen }, data, now),
    idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 201, now),
  ];
  try { await c.env.DB.batch(statements); } catch {
    const later = await c.env.DB.prepare(`SELECT id FROM financial_entries WHERE reverses_entry_id=? LIMIT 1`).bind(original.id).first<{ id: string }>();
    if (later) return c.json(apiError('ENTRY_ALREADY_REVERSED', '该流水已被其他请求冲销'), 409);
    return c.json(apiError('ENTRY_CONFLICT', '冲销失败'), 409);
  }
  return c.json(response, 201);
});

p4App.get('/finance/summary', async (c) => {
  const frameworkId = cleanText(c.req.query('frameworkId')), asOf = dateValue(c.req.query('asOf'));
  if (!frameworkId || !asOf) return c.json(apiError('INVALID_SUMMARY_QUERY', 'frameworkId 和 asOf 必须有效'), 400);
  const framework = await findFramework(c.env.DB, frameworkId); if (!framework) return c.json(apiError('NOT_FOUND', '框架不存在'), 404);
  if (!canFramework(c, frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该框架资金数据'), 403);

  const [budget, entries, agreementsResult, committedResult, usedResult] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(bv.total_amount_fen),0) AS total
       FROM project_budgets pb INNER JOIN budget_versions bv ON bv.budget_id=pb.id AND bv.budget_version=pb.budget_version
       WHERE bv.framework_id=?`,
    ).bind(frameworkId).first<{ total: number | string }>(),
    c.env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN entry_type='budget_occurrence' THEN amount_fen ELSE 0 END),0) AS budget_occurrence,
         COALESCE(SUM(CASE WHEN entry_type='actual_cost' THEN amount_fen ELSE 0 END),0) AS actual_cost
       FROM financial_entries WHERE framework_id=? AND business_date<=?`,
    ).bind(frameworkId, asOf).first<{ budget_occurrence: number | string; actual_cost: number | string }>(),
    c.env.DB.prepare(`SELECT id,framework_id,code,name,amount_fen,valid_from,valid_to,status,version,created_at,updated_at FROM agreements WHERE framework_id=? ORDER BY code COLLATE NOCASE,id`).bind(frameworkId).all<AgreementRow>(),
    c.env.DB.prepare(
      `SELECT bva.agreement_id,COALESCE(SUM(bva.amount_fen),0) AS total
       FROM budget_version_allocations bva
       INNER JOIN budget_versions bv ON bv.id=bva.budget_version_id
       INNER JOIN project_budgets pb ON pb.id=bv.budget_id AND pb.budget_version=bv.budget_version
       WHERE bv.framework_id=?
       GROUP BY bva.agreement_id`,
    ).bind(frameworkId).all<{ agreement_id: string; total: number | string }>(),
    c.env.DB.prepare(
      `SELECT fea.agreement_id,
              COALESCE(SUM(CASE WHEN fe.entry_type='budget_occurrence' THEN fea.amount_fen ELSE 0 END),0) AS occurrence,
              COALESCE(SUM(CASE WHEN fe.entry_type='actual_cost' THEN fea.amount_fen ELSE 0 END),0) AS actual
       FROM financial_entry_allocations fea INNER JOIN financial_entries fe ON fe.id=fea.financial_entry_id
       WHERE fe.framework_id=? AND fe.business_date<=?
       GROUP BY fea.agreement_id`,
    ).bind(frameworkId, asOf).all<{ agreement_id: string; occurrence: number | string; actual: number | string }>(),
  ]);
  const confirmedBudgetFen = parseSqlSafeInteger(budget?.total ?? 0);
  const budgetOccurrenceFen = parseSqlSafeInteger(entries?.budget_occurrence ?? 0);
  const actualCostFen = parseSqlSafeInteger(entries?.actual_cost ?? 0);
  if (confirmedBudgetFen === null || budgetOccurrenceFen === null || actualCostFen === null) {
    return c.json(apiError('AMOUNT_OVERFLOW', '资金汇总金额超出安全整数范围'), 422);
  }
  const committedByAgreement = new Map<string, number>();
  for (const row of committedResult.results ?? []) {
    const amount = parseSqlSafeInteger(row.total);
    if (amount === null) return c.json(apiError('AMOUNT_OVERFLOW', '协议预算汇总金额超出安全整数范围'), 422);
    committedByAgreement.set(row.agreement_id, amount);
  }
  const usedByAgreement = new Map<string, { occurrence: number; actual: number }>();
  for (const row of usedResult.results ?? []) {
    const occurrence = parseSqlSafeInteger(row.occurrence), actual = parseSqlSafeInteger(row.actual);
    if (occurrence === null || actual === null) return c.json(apiError('AMOUNT_OVERFLOW', '协议发生汇总金额超出安全整数范围'), 422);
    usedByAgreement.set(row.agreement_id, { occurrence, actual });
  }
  const metrics: FinanceAgreementMetric[] = [];
  const effectiveAgreementAmounts: number[] = [];
  for (const agreement of agreementsResult.results ?? []) {
    const committed = committedByAgreement.get(agreement.id) ?? 0;
    const used = usedByAgreement.get(agreement.id) ?? { occurrence: 0, actual: 0 };
    const bp = basisPoints(used.occurrence, agreement.amount_fen);
    const effective = agreement.status === 'active' && asOf >= agreement.valid_from && asOf <= agreement.valid_to;
    if (effective) effectiveAgreementAmounts.push(agreement.amount_fen);
    metrics.push({ id: agreement.id, code: agreement.code, name: agreement.name, amountFen: agreement.amount_fen, budgetCommittedFen: committed, budgetOccurrenceFen: used.occurrence, actualCostFen: used.actual, usageBasisPoints: bp, usageConfigured: bp !== null, usageWarning: ratioAtLeast(used.occurrence, agreement.amount_fen, 9000) });
  }
  const agreementReservedFen = safeSum(effectiveAgreementAmounts);
  if (agreementReservedFen === null) return c.json(apiError('AMOUNT_OVERFLOW', '有效协议额度合计超出安全整数范围'), 422);
  const frameworkUsage = basisPoints(budgetOccurrenceFen, framework.total_amount_fen);
  const annualDenominator = framework.annual_target_fen ?? framework.total_amount_fen;
  const annualProgress = basisPoints(budgetOccurrenceFen, annualDenominator);
  const data: FrameworkFinanceSummary = {
    framework: frameworkSummary(framework), asOf, confirmedBudgetFen, budgetOccurrenceFen, actualCostFen, agreementReservedFen,
    frameworkUsageBasisPoints: frameworkUsage, frameworkUsageConfigured: frameworkUsage !== null, frameworkUsageWarning: ratioAtLeast(budgetOccurrenceFen, framework.total_amount_fen, 8000),
    annualProgressBasisPoints: annualProgress, annualProgressConfigured: annualProgress !== null,
    budgetOverFrameworkWarning: confirmedBudgetFen > framework.total_amount_fen, agreements: metrics,
  };
  return c.json({ ok: true as const, data });
});
