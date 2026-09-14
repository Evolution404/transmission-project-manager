import { Hono, type Context } from 'hono';
import type {
  AgreementStatus,
  AgreementSummary,
  ApiError,
  BindProjectFrameworkRequest,
  BudgetAllocationInput,
  BudgetAllocationSummary,
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
import { SqlFinanceBudgetRepository } from './repositories/sql-finance-budget-repository';
import { SqlFinanceEntryRepository } from './repositories/sql-finance-entry-repository';
import { SqlFinanceQueryRepository } from './repositories/sql-finance-query-repository';
import { SqlFinanceSummaryRepository } from './repositories/sql-finance-summary-repository';
import { SqlFinanceWriteRepository } from './repositories/sql-finance-write-repository';
import { SqlIdempotencyRepository } from './repositories/sql-idempotency-repository';
import { createCloudflarePersistence } from './runtime/cloudflare/persistence';

const MAX_PAGE_SIZE = 100;

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
function basisPoints(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  const value = (BigInt(numerator) * 10000n + BigInt(Math.floor(denominator / 2))) / BigInt(denominator);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}
function ratioAtLeast(numerator: number, denominator: number, thresholdBasisPoints: number) {
  return denominator > 0 && BigInt(numerator) * 10000n >= BigInt(denominator) * BigInt(thresholdBasisPoints);
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
  const { database } = createCloudflarePersistence(c.env);
  const items = (await new SqlFinanceBudgetRepository(database).listBudgets(projectId || null))
    .filter((budget) => canProject(c, budget.projectId) || (budget.frameworkId !== null && canFramework(c, budget.frameworkId)));
  return c.json({ ok: true as const, data: { items } });
});

p4App.post('/budgets', requireRoles('admin', 'project_manager', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Partial<CreateBudgetRequest>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const projectId = cleanText(body.projectId), total = safeNonNegative(body.totalAmountFen), allocations = normalizeAllocations(body.allocations), note = nullableText(body.note, 1000);
  if (!projectId || total === null || !allocations || note === undefined) return c.json(apiError('INVALID_BUDGET', '预算参数无效'), 422);
  const { database } = createCloudflarePersistence(c.env);
  const queryRepository = new SqlFinanceQueryRepository(database);
  const budgetRepository = new SqlFinanceBudgetRepository(database);
  const project = await queryRepository.findProject(projectId); if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 422);
  if (!canProject(c, projectId) && !(project.frameworkId && canFramework(c, project.frameworkId))) return c.json(apiError('SCOPE_FORBIDDEN', '无权管理该项目预算'), 403);
  if (allocations.length && !project.frameworkId) return c.json(apiError('PROJECT_FRAMEWORK_REQUIRED', '项目未归属框架，不能分配协议'), 422);
  let summaries: BudgetAllocationSummary[] = [];
  if (project.frameworkId) {
    const checked = await queryRepository.validateAgreementAllocations(project.frameworkId, allocations, null, false);
    if (!checked.ok) {
      if (checked.reason === 'not_found') return c.json(apiError('AGREEMENT_NOT_FOUND', '协议不存在'), 422);
      if (checked.reason === 'framework_mismatch') return c.json(apiError('AGREEMENT_FRAMEWORK_MISMATCH', '协议与项目不属于同一框架'), 422);
      return c.json(apiError('AGREEMENT_NOT_EFFECTIVE', '协议在业务日期不是有效状态'), 422);
    }
    summaries = checked.summaries;
  }
  const request: CreateBudgetRequest = { projectId, totalAmountFen: total, allocations, note };
  const hash = await requestHash(request), operation = 'budgets.create'; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), id = crypto.randomUUID(), now = new Date().toISOString();
  const data: ProjectBudgetSummary = { id, projectId, projectName: project.name, frameworkId: project.frameworkId, totalAmountFen: total, note, status: 'draft', budgetVersion: 0, version: 1, allocations: summaries, createdAt: now, updatedAt: now };
  const response = { ok: true as const, data };
  try {
    await budgetRepository.createBudget({
      budget: data,
      allocations: allocations.map((item) => ({ id: crypto.randomUUID(), agreementId: item.agreementId, amountFen: item.amountFen })),
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch { return c.json(apiError('BUDGET_CONFLICT', '项目预算已存在或数据冲突'), 409); }
  return c.json(response, 201);
});

p4App.put('/budgets/:id', requireRoles('admin', 'project_manager', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const { database } = createCloudflarePersistence(c.env);
  const queryRepository = new SqlFinanceQueryRepository(database);
  const budgetRepository = new SqlFinanceBudgetRepository(database);
  const current = await budgetRepository.findBudget(c.req.param('id')); if (!current) return c.json(apiError('NOT_FOUND', '预算不存在'), 404);
  if (!canProject(c, current.projectId) && !(current.frameworkId && canFramework(c, current.frameworkId))) return c.json(apiError('SCOPE_FORBIDDEN', '无权修改该预算'), 403);
  let body: Partial<UpdateBudgetRequest>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion), total = safeNonNegative(body.totalAmountFen), allocations = normalizeAllocations(body.allocations), note = nullableText(body.note, 1000);
  if (version === null || total === null || !allocations || note === undefined) return c.json(apiError('INVALID_BUDGET', '预算更新参数无效'), 422);
  const request: UpdateBudgetRequest = { expectedVersion: version, totalAmountFen: total, allocations, note };
  const hash = await requestHash(request), operation = `budgets.update:${current.id}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (current.version !== version) return c.json(apiError('VERSION_CONFLICT', '预算已被修改，请刷新后重试'), 409);
  const project = await queryRepository.findProject(current.projectId); if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 422);
  if (allocations.length && !project.frameworkId) return c.json(apiError('PROJECT_FRAMEWORK_REQUIRED', '项目未归属框架，不能分配协议'), 422);
  let summaries: BudgetAllocationSummary[] = [];
  if (project.frameworkId) {
    const checked = await queryRepository.validateAgreementAllocations(project.frameworkId, allocations, null, false);
    if (!checked.ok) {
      if (checked.reason === 'not_found') return c.json(apiError('AGREEMENT_NOT_FOUND', '协议不存在'), 422);
      if (checked.reason === 'framework_mismatch') return c.json(apiError('AGREEMENT_FRAMEWORK_MISMATCH', '协议与项目不属于同一框架'), 422);
      return c.json(apiError('AGREEMENT_NOT_EFFECTIVE', '协议在业务日期不是有效状态'), 422);
    }
    summaries = checked.summaries;
  }
  const actor = c.get('currentUser'), now = new Date().toISOString();
  const data: ProjectBudgetSummary = { ...current, frameworkId: project.frameworkId, totalAmountFen: total, note, status: 'draft', version: version + 1, allocations: summaries, updatedAt: now };
  const response = { ok: true as const, data };
  try {
    await budgetRepository.updateBudget({
      before: current,
      next: data,
      expectedVersion: version,
      allocations: allocations.map((item) => ({ id: crypto.randomUUID(), agreementId: item.agreementId, amountFen: item.amountFen })),
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    const latest = await budgetRepository.findBudget(current.id); if (latest && latest.version !== version) return c.json(apiError('VERSION_CONFLICT', '预算已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('BUDGET_CONFLICT', '预算更新失败'), 409);
  }
  return c.json(response);
});

p4App.post('/budgets/:id/confirm', requireRoles('admin', 'project_manager', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const { database } = createCloudflarePersistence(c.env);
  const queryRepository = new SqlFinanceQueryRepository(database);
  const budgetRepository = new SqlFinanceBudgetRepository(database);
  const current = await budgetRepository.findBudget(c.req.param('id')); if (!current) return c.json(apiError('NOT_FOUND', '预算不存在'), 404);
  if (!canProject(c, current.projectId) && !(current.frameworkId && canFramework(c, current.frameworkId))) return c.json(apiError('SCOPE_FORBIDDEN', '无权确认该预算'), 403);
  let body: Partial<ConfirmBudgetRequest>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion); if (version === null) return c.json(apiError('INVALID_VERSION', 'expectedVersion 无效'), 422);
  const request = { expectedVersion: version }; const hash = await requestHash(request), operation = `budgets.confirm:${current.id}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (current.version !== version) return c.json(apiError('VERSION_CONFLICT', '预算已被修改，请刷新后重试'), 409);
  const project = await queryRepository.findProject(current.projectId); if (!project?.frameworkId) return c.json(apiError('PROJECT_FRAMEWORK_REQUIRED', '确认预算前项目必须归属框架'), 422);
  const sum = safeSum(current.allocations.map((item) => item.amountFen));
  if (!current.allocations.length || sum === null || sum !== current.totalAmountFen) return c.json(apiError('BUDGET_ALLOCATION_MISMATCH', '确认预算时协议分配合计必须精确等于预算总额'), 422);
  const checked = await queryRepository.validateAgreementAllocations(project.frameworkId, current.allocations, today(), true);
  if (!checked.ok) {
    if (checked.reason === 'not_found') return c.json(apiError('AGREEMENT_NOT_FOUND', '协议不存在'), 422);
    if (checked.reason === 'framework_mismatch') return c.json(apiError('AGREEMENT_FRAMEWORK_MISMATCH', '协议与项目不属于同一框架'), 422);
    return c.json(apiError('AGREEMENT_NOT_EFFECTIVE', '协议在业务日期不是有效状态'), 422);
  }
  const actor = c.get('currentUser'), now = new Date().toISOString(), budgetVersion = current.budgetVersion + 1, versionId = crypto.randomUUID();
  const data: ProjectBudgetSummary = { ...current, frameworkId: project.frameworkId, status: 'confirmed', budgetVersion, version: version + 1, updatedAt: now };
  const response = { ok: true as const, data };
  try {
    await budgetRepository.confirmBudget({
      before: current,
      next: data,
      expectedVersion: version,
      budgetVersionId: versionId,
      allocations: current.allocations.map((item) => ({ id: crypto.randomUUID(), agreementId: item.agreementId, amountFen: item.amountFen })),
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    const latest = await budgetRepository.findBudget(current.id); if (latest && latest.version !== version) return c.json(apiError('VERSION_CONFLICT', '预算已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('BUDGET_CONFIRM_CONFLICT', '预算确认失败'), 409);
  }
  return c.json(response);
});

p4App.get('/budgets/:id/history', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  const budgetRepository = new SqlFinanceBudgetRepository(database);
  const budget = await budgetRepository.findBudget(c.req.param('id')); if (!budget) return c.json(apiError('NOT_FOUND', '预算不存在'), 404);
  if (!canProject(c, budget.projectId) && !(budget.frameworkId && canFramework(c, budget.frameworkId))) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该预算'), 403);
  const items = await budgetRepository.getBudgetHistory(budget.id);
  return c.json({ ok: true as const, data: { items: items ?? [] } });
});

p4App.get('/financial-entries', async (c) => {
  const frameworkId = cleanText(c.req.query('frameworkId')), projectId = cleanText(c.req.query('projectId'));
  const limit = Number(c.req.query('limit') ?? '50');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return c.json(apiError('INVALID_PAGE_LIMIT', 'limit 必须在 1 到 100 之间'), 400);
  const cursorParam = c.req.query('cursor');
  const cursor = parseEntryCursor(cursorParam);
  if (cursorParam && !cursor) return c.json(apiError('INVALID_CURSOR', '资金流水分页游标无效'), 400);
  if (frameworkId && !canFramework(c, frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该框架流水'), 403);
  if (projectId && !canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目流水'), 403);
  const { database } = createCloudflarePersistence(c.env);
  const rows = await new SqlFinanceEntryRepository(database).listEntries({
    frameworkId: frameworkId || null,
    projectId: projectId || null,
    cursor,
    limit: limit + 1,
  });
  const visible = rows.filter((row) => canProject(c, row.projectId) || canFramework(c, row.frameworkId));
  const items = visible.slice(0, limit);
  const last = items.at(-1);
  const data: FinancialEntryPage = {
    items,
    nextCursor: visible.length > limit && last ? makeEntryCursor(last.businessDate, last.createdAt, last.id) : null,
  };
  return c.json({ ok: true as const, data });
});

p4App.post('/financial-entries', requireRoles('admin', 'project_manager', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Partial<CreateFinancialEntryRequest>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const type = cleanText(body.type) as FinancialEntryType, projectId = cleanText(body.projectId), amount = safePositive(body.amountFen), businessDate = dateValue(body.businessDate), allocations = normalizeEntryAllocations(body.allocations), note = nullableText(body.note, 1000);
  if (!['budget_occurrence','actual_cost'].includes(type) || !projectId || amount === null || !businessDate || !allocations || note === undefined) return c.json(apiError('INVALID_FINANCIAL_ENTRY', '资金流水参数无效'), 422);
  const { database } = createCloudflarePersistence(c.env);
  const queryRepository = new SqlFinanceQueryRepository(database);
  const entryRepository = new SqlFinanceEntryRepository(database);
  const project = await queryRepository.findProject(projectId); if (!project?.frameworkId) return c.json(apiError('PROJECT_FRAMEWORK_REQUIRED', '登记资金流水前项目必须归属框架'), 422);
  if (!canProject(c, projectId) && !canFramework(c, project.frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权登记该项目资金流水'), 403);
  const sum = safeSum(allocations.map((item) => item.amountFen));
  if (!allocations.length || sum === null || sum !== amount) return c.json(apiError('ENTRY_ALLOCATION_MISMATCH', '协议分配合计必须精确等于流水金额'), 422);
  const checked = await queryRepository.validateAgreementAllocations(project.frameworkId, allocations, businessDate, true);
  if (!checked.ok) {
    if (checked.reason === 'not_found') return c.json(apiError('AGREEMENT_NOT_FOUND', '协议不存在'), 422);
    if (checked.reason === 'framework_mismatch') return c.json(apiError('AGREEMENT_FRAMEWORK_MISMATCH', '协议与项目不属于同一框架'), 422);
    return c.json(apiError('AGREEMENT_NOT_EFFECTIVE', '协议在业务日期不是有效状态'), 422);
  }
  const request: CreateFinancialEntryRequest = { type, projectId, amountFen: amount, businessDate, allocations, note };
  const hash = await requestHash(request), operation = 'financial-entries.create'; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), id = crypto.randomUUID(), now = new Date().toISOString();
  const data: FinancialEntrySummary = { id, frameworkId: project.frameworkId, projectId, projectName: project.name, type, businessDate, amountFen: amount, note, reversesEntryId: null, allocations: checked.summaries, createdAt: now };
  const response = { ok: true as const, data };
  try {
    await entryRepository.createEntry({
      entry: data,
      allocations: allocations.map((item) => ({ id: crypto.randomUUID(), agreementId: item.agreementId, amountFen: item.amountFen })),
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch { return c.json(apiError('ENTRY_CONFLICT', '资金流水写入失败'), 409); }
  return c.json(response, 201);
});

p4App.post('/financial-entries/:id/reverse', requireRoles('admin', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const { database } = createCloudflarePersistence(c.env);
  const entryRepository = new SqlFinanceEntryRepository(database);
  const original = await entryRepository.findEntry(c.req.param('id'));
  if (!original) return c.json(apiError('NOT_FOUND', '资金流水不存在'), 404);
  if (original.reversesEntryId || original.amountFen < 0) return c.json(apiError('ENTRY_NOT_REVERSIBLE', '冲销记录不能再次冲销'), 422);
  if (!canProject(c, original.projectId) && !canFramework(c, original.frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权冲销该流水'), 403);
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const businessDate = dateValue(body.businessDate), reason = nullableText(body.reason, 1000);
  if (!businessDate || !reason) return c.json(apiError('INVALID_REVERSAL', '冲销日期和原因不能为空'), 422);
  const request = { businessDate, reason }; const hash = await requestHash(request), operation = `financial-entries.reverse:${original.id}`; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (await entryRepository.hasReversal(original.id)) return c.json(apiError('ENTRY_ALREADY_REVERSED', '该流水已被冲销'), 409);
  const actor = c.get('currentUser'), id = crypto.randomUUID(), now = new Date().toISOString();
  const allocations = original.allocations.map((item) => ({ ...item, amountFen: -item.amountFen }));
  const data: FinancialEntrySummary = { id, frameworkId: original.frameworkId, projectId: original.projectId, projectName: original.projectName, type: original.type, businessDate, amountFen: -original.amountFen, note: reason, reversesEntryId: original.id, allocations, createdAt: now };
  const response = { ok: true as const, data };
  try {
    await entryRepository.reverseEntry({
      original,
      reversal: data,
      allocations: allocations.map((item) => ({ id: crypto.randomUUID(), agreementId: item.agreementId, amountFen: item.amountFen })),
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    if (await entryRepository.hasReversal(original.id)) return c.json(apiError('ENTRY_ALREADY_REVERSED', '该流水已被其他请求冲销'), 409);
    return c.json(apiError('ENTRY_CONFLICT', '冲销失败'), 409);
  }
  return c.json(response, 201);
});

p4App.get('/finance/summary', async (c) => {
  const frameworkId = cleanText(c.req.query('frameworkId')), asOf = dateValue(c.req.query('asOf'));
  if (!frameworkId || !asOf) return c.json(apiError('INVALID_SUMMARY_QUERY', 'frameworkId 和 asOf 必须有效'), 400);
  const { database } = createCloudflarePersistence(c.env);
  const framework = await new SqlFinanceQueryRepository(database).findFramework(frameworkId); if (!framework) return c.json(apiError('NOT_FOUND', '框架不存在'), 404);
  if (!canFramework(c, frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该框架资金数据'), 403);

  let facts;
  try {
    facts = await new SqlFinanceSummaryRepository(database).getFacts(frameworkId, asOf);
  } catch (error) {
    if (error instanceof RangeError) return c.json(apiError('AMOUNT_OVERFLOW', '资金汇总金额超出安全整数范围'), 422);
    throw error;
  }
  const metrics: FinanceAgreementMetric[] = [];
  const effectiveAgreementAmounts: number[] = [];
  for (const item of facts.agreements) {
    const agreement = item.agreement;
    const bp = basisPoints(item.budgetOccurrenceFen, agreement.amountFen);
    const effective = agreement.status === 'active' && asOf >= agreement.validFrom && asOf <= agreement.validTo;
    if (effective) effectiveAgreementAmounts.push(agreement.amountFen);
    metrics.push({
      id: agreement.id,
      code: agreement.code,
      name: agreement.name,
      amountFen: agreement.amountFen,
      budgetCommittedFen: item.budgetCommittedFen,
      budgetOccurrenceFen: item.budgetOccurrenceFen,
      actualCostFen: item.actualCostFen,
      usageBasisPoints: bp,
      usageConfigured: bp !== null,
      usageWarning: ratioAtLeast(item.budgetOccurrenceFen, agreement.amountFen, 9000),
    });
  }
  const agreementReservedFen = safeSum(effectiveAgreementAmounts);
  if (agreementReservedFen === null) return c.json(apiError('AMOUNT_OVERFLOW', '有效协议额度合计超出安全整数范围'), 422);
  const frameworkUsage = basisPoints(facts.budgetOccurrenceFen, framework.totalAmountFen);
  const annualDenominator = framework.annualTargetFen ?? framework.totalAmountFen;
  const annualProgress = basisPoints(facts.budgetOccurrenceFen, annualDenominator);
  const data: FrameworkFinanceSummary = {
    framework,
    asOf,
    confirmedBudgetFen: facts.confirmedBudgetFen,
    budgetOccurrenceFen: facts.budgetOccurrenceFen,
    actualCostFen: facts.actualCostFen,
    agreementReservedFen,
    frameworkUsageBasisPoints: frameworkUsage,
    frameworkUsageConfigured: frameworkUsage !== null,
    frameworkUsageWarning: ratioAtLeast(facts.budgetOccurrenceFen, framework.totalAmountFen, 8000),
    annualProgressBasisPoints: annualProgress,
    annualProgressConfigured: annualProgress !== null,
    budgetOverFrameworkWarning: facts.confirmedBudgetFen > framework.totalAmountFen,
    agreements: metrics,
  };
  return c.json({ ok: true as const, data });
});
