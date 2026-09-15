import { Hono, type Context } from 'hono';
import type {
  AnalysisDashboardSummary,
  AnalysisLagMode,
  AnalysisRuleSummary,
  ApiError,
  MilestoneDatePrecision,
  MilestoneStatus,
  MilestoneSummary,
  MonthlyPlanSummary,
  MonthlyReportSummary,
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
import { resolvePersistence as createCloudflarePersistence } from './runtime/persistence.ts';
import { SqlAnalysisRepository } from './repositories/sql-analysis-repository.ts';

function cleanText(value: unknown) { return value === null || value === undefined ? '' : String(value).trim(); }
function safeNonNegative(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function expectedVersion(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null; }
function validDate(value: unknown): string | null {
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const d = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(d.valueOf()) || d.toISOString().slice(0, 10) !== text ? null : text;
}
function validMonth(value: unknown): string | null {
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}$/.test(text)) return null;
  const month = Number(text.slice(5, 7));
  return month >= 1 && month <= 12 ? text : null;
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
