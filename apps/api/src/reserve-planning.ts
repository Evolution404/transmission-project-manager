import { Hono, type Context } from 'hono';
import type {
  CategoryMappingSummary,
  ConfirmProjectRequest,
  CreateProjectRequest,
  FixedCostInput,
  MaterialPriceInput,
  ProjectAllocationDetail,
  ProjectCategorySummary,
  ProjectCostSummary,
  ProjectSummary,
  ReplaceCategoryAllocationsRequest,
  ReplaceProjectAllocationsRequest,
  ReplaceProjectCostsRequest,
  ReserveCategorySummary,
} from '@tpm/shared';
import { hasScope, requireRoles, type AppEnv } from './auth.ts';
import { replayIdempotentResponse, requestHash, requireIdempotencyKey } from './http/idempotent-mutation.ts';
import { apiError } from './http/request-values.ts';
import { SqlProjectQueryRepository } from './repositories/sql-project-query-repository.ts';
import { SqlProjectWriteRepository } from './repositories/sql-project-write-repository.ts';
import { SqlReserveCategoryWriteRepository } from './repositories/sql-reserve-category-write-repository.ts';
import { resolvePersistence as createCloudflarePersistence } from './runtime/persistence.ts';

const MAX_PROJECT_ALLOCATIONS = 100;
const MAX_PAGE_SIZE = 100;

function cleanText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function parseExpectedVersion(value: unknown): number | null {
  const version = Number(value);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

function validYear(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return undefined;
  return year;
}

function validDate(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const date = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  return date;
}

function safeNonNegativeInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function safePositiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function parseCursor(value: string | undefined): { createdAt: string; id: string } | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))) as { createdAt?: unknown; id?: unknown };
    if (typeof decoded.createdAt !== 'string' || typeof decoded.id !== 'string') return null;
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    return null;
  }
}

function makeCursor(createdAt: string, id: string) {
  return btoa(JSON.stringify({ createdAt, id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseCandidateCursor(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))) as { id?: unknown };
    return typeof decoded.id === 'string' && decoded.id ? decoded.id : null;
  } catch {
    return null;
  }
}

function makeCandidateCursor(id: string) {
  return btoa(JSON.stringify({ id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function canAccessProject(c: Context<AppEnv>, projectId: string) {
  const user = c.get('currentUser');
  return user.role === 'admin' || hasScope(user.scopes, 'project', projectId);
}

function validateAllocationInput(value: unknown): CreateProjectRequest['allocations'] | null {
  if (!Array.isArray(value) || value.length > MAX_PROJECT_ALLOCATIONS) return null;
  const seen = new Set<string>();
  const allocations: CreateProjectRequest['allocations'] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const candidate = item as { demandMaterialId?: unknown; quantityScaled?: unknown };
    const demandMaterialId = cleanText(candidate.demandMaterialId);
    const quantityScaled = safePositiveInteger(candidate.quantityScaled);
    if (!demandMaterialId || quantityScaled === null || seen.has(demandMaterialId)) return null;
    seen.add(demandMaterialId);
    allocations.push({ demandMaterialId, quantityScaled });
  }
  return allocations;
}

function calculateAmountFen(quantityScaled: number, unitPriceScaled: number): number | null {
  const product = BigInt(quantityScaled) * BigInt(unitPriceScaled);
  const rounded = (product + 500_000n) / 1_000_000n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(rounded);
}

export const reservePlanningApp = new Hono<AppEnv>();

reservePlanningApp.get('/projects/candidates', async (c) => {
  const limit = Number(c.req.query('limit') ?? '50');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return c.json(apiError('INVALID_PAGE_LIMIT', 'limit 必须在 1 到 100 之间'), 400);
  const cursorParam = c.req.query('cursor');
  const cursor = parseCandidateCursor(cursorParam);
  if (cursorParam && !cursor) return c.json(apiError('INVALID_CURSOR', '候选需求分页游标无效'), 400);
  const { database } = createCloudflarePersistence(c.env);
  const page = await new SqlProjectQueryRepository(database).listCandidates({ limit, cursor });
  return c.json({ ok: true as const, data: { items: page.items, nextCursor: page.nextCursor ? makeCandidateCursor(page.nextCursor) : null } });
});

reservePlanningApp.get('/projects/suggestions', async (c) => {
  const limit = Number(c.req.query('limit') ?? '50');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return c.json(apiError('INVALID_PAGE_LIMIT', 'limit 必须在 1 到 100 之间'), 400);
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlProjectQueryRepository(database).listSuggestions(limit) } });
});

reservePlanningApp.post('/projects', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: Partial<CreateProjectRequest>;
  try { body = await c.req.json<Partial<CreateProjectRequest>>(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const name = cleanText(body.name);
  const year = validYear(body.year);
  const owner = body.owner === null || body.owner === undefined ? null : cleanText(body.owner);
  const allocations = validateAllocationInput(body.allocations);
  if (!name || name.length > 120 || year === undefined || (owner !== null && owner.length > 80) || !allocations) {
    return c.json(apiError('INVALID_PROJECT', '项目名称、年度、负责人或分配明细无效'), 422);
  }
  const actor = c.get('currentUser');
  if (actor.role !== 'admin' && !actor.scopes.some((scope) => scope.type === 'all')) {
    return c.json(apiError('SCOPE_FORBIDDEN', '当前项目管理成员没有创建新项目的全局范围'), 403);
  }
  const requestBody: CreateProjectRequest = { name, year, owner, allocations };
  const hash = await requestHash(requestBody);
  const operation = 'projects.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const response = {
    ok: true as const,
    data: {
      id,
      name,
      year,
      owner,
      status: 'draft' as const,
      reserveVersion: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
      knownAmountFen: 0,
      missingPriceCount: allocations.length,
      completenessBasisPoints: 0,
    } satisfies ProjectSummary,
  };
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlProjectWriteRepository(database);
  try {
    await repository.create({
      project: response.data,
      allocations: allocations.map((allocation) => ({
        id: crypto.randomUUID(),
        demandMaterialId: allocation.demandMaterialId,
        quantityScaled: allocation.quantityScaled,
      })),
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    const failure = await repository.findAllocationFailure(allocations);
    if (failure) return c.json(apiError(failure.code, failure.message, failure.details), failure.status);
    return c.json(apiError('PROJECT_CREATE_CONFLICT', '项目创建发生并发冲突，请刷新后重试'), 409);
  }
  return c.json(response, 201);
});

reservePlanningApp.get('/projects', async (c) => {
  const limit = Number(c.req.query('limit') ?? '50');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return c.json(apiError('INVALID_PAGE_LIMIT', 'limit 必须在 1 到 100 之间'), 400);
  const cursorParam = c.req.query('cursor');
  const cursor = parseCursor(cursorParam);
  if (cursorParam && !cursor) return c.json(apiError('INVALID_CURSOR', '分页游标无效'), 400);
  const user = c.get('currentUser');
  const hasAll = user.role === 'admin' || user.scopes.some((scope) => scope.type === 'all');
  const projectIds = user.scopes.filter((scope) => scope.type === 'project' && scope.id).map((scope) => scope.id as string);
  const { database } = createCloudflarePersistence(c.env);
  const page = await new SqlProjectQueryRepository(database).listProjects({
    allowedProjectIds: hasAll ? null : projectIds,
    cursor,
    limit,
  });
  return c.json({ ok: true as const, data: { items: page.items, nextCursor: page.nextCursor ? makeCursor(page.nextCursor.createdAt, page.nextCursor.id) : null } });
});

reservePlanningApp.get('/projects/:id', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  const detail = await new SqlProjectQueryRepository(database).getProjectDetail(c.req.param('id'));
  if (!detail) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!canAccessProject(c, detail.id)) return c.json(apiError('SCOPE_FORBIDDEN', '当前成员无权访问该项目'), 403);
  return c.json({ ok: true as const, data: detail });
});

reservePlanningApp.put('/projects/:id/allocations', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: Partial<ReplaceProjectAllocationsRequest>;
  try { body = await c.req.json<Partial<ReplaceProjectAllocationsRequest>>(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expectedVersion = parseExpectedVersion(body.expectedVersion);
  const allocations = validateAllocationInput(body.allocations);
  if (expectedVersion === null || !allocations) return c.json(apiError('INVALID_ALLOCATIONS', 'expectedVersion 或分配明细无效'), 422);
  const operation = `projects.allocations:${c.req.param('id')}`;
  const requestBody = { expectedVersion, allocations };
  const hash = await requestHash(requestBody);
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlProjectWriteRepository(database);
  const project = await repository.findProject(c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!canAccessProject(c, project.id)) return c.json(apiError('SCOPE_FORBIDDEN', '当前成员无权修改该项目'), 403);
  if (project.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const protectedScope = await repository.getProtectedScope(project.id);
  const requestedQuantities = new Map(allocations.map((item) => [item.demandMaterialId, item.quantityScaled]));
  for (const { demandMaterialId, protectedQuantityScaled } of protectedScope) {
    const requestedQuantityScaled = requestedQuantities.get(demandMaterialId) ?? 0;
    if (requestedQuantityScaled < protectedQuantityScaled) {
      return c.json(apiError(
        'PROJECT_SCOPE_PROTECTED',
        '已有出库、实施或有效结算的项目范围不能被储备修改缩小',
        { demandMaterialId, protectedQuantityScaled, requestedQuantityScaled },
      ), 422);
    }
  }

  const actor = c.get('currentUser');
  const now = new Date().toISOString();
  const nextVersion = expectedVersion + 1;
  const response = {
    ok: true as const,
    data: {
      id: project.id,
      name: project.name,
      year: project.year,
      owner: project.owner,
      status: 'draft' as const,
      reserveVersion: project.reserveVersion,
      version: nextVersion,
      createdAt: project.createdAt,
      updatedAt: now,
      knownAmountFen: 0,
      missingPriceCount: allocations.length,
      completenessBasisPoints: 0,
    } satisfies ProjectSummary,
  };
  try {
    await repository.replaceAllocations({
      projectId: project.id,
      expectedVersion,
      now,
      allocations: allocations.map((allocation) => ({
        id: crypto.randomUUID(),
        demandMaterialId: allocation.demandMaterialId,
        quantityScaled: allocation.quantityScaled,
      })),
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    const current = await repository.findProject(project.id);
    if (current && current.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    const failure = await repository.findAllocationFailure(allocations);
    if (failure) return c.json(apiError(failure.code, failure.message, failure.details), failure.status);
    return c.json(apiError('ALLOCATION_UPDATE_CONFLICT', '分配更新发生冲突，请刷新后重试'), 409);
  }
  return c.json(response);
});

reservePlanningApp.put('/projects/:id/costs', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: Partial<ReplaceProjectCostsRequest>;
  try { body = await c.req.json<Partial<ReplaceProjectCostsRequest>>(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expectedVersion = parseExpectedVersion(body.expectedVersion);
  if (expectedVersion === null || !Array.isArray(body.materialPrices) || !Array.isArray(body.fixedCosts)) {
    return c.json(apiError('INVALID_COSTS', 'expectedVersion、物资单价或固定费用格式无效'), 422);
  }
  const operation = `projects.costs:${c.req.param('id')}`;
  const requestBody = { expectedVersion, materialPrices: body.materialPrices, fixedCosts: body.fixedCosts };
  const hash = await requestHash(requestBody);
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const { database } = createCloudflarePersistence(c.env);
  const queryRepository = new SqlProjectQueryRepository(database);
  const writeRepository = new SqlProjectWriteRepository(database);
  const project = await queryRepository.getProjectDetail(c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!canAccessProject(c, project.id)) return c.json(apiError('SCOPE_FORBIDDEN', '当前成员无权修改该项目'), 403);
  if (project.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);

  const allocations = project.allocations;
  if (allocations.length === 0) return c.json(apiError('PROJECT_EMPTY', '项目没有需求物资分配，不能估算'), 422);
  const allocationMap = new Map(allocations.map((item) => [item.id, item]));
  const priceMap = new Map<string, MaterialPriceInput>();
  for (const raw of body.materialPrices) {
    const item = raw as MaterialPriceInput;
    const allocationId = cleanText(item?.demandAllocationId);
    if (!allocationId || !allocationMap.has(allocationId) || priceMap.has(allocationId)) return c.json(apiError('INVALID_MATERIAL_PRICE', '物资单价引用了无效或重复的项目分配'), 422);
    if (item.unitPriceScaled !== null && safeNonNegativeInteger(item.unitPriceScaled) === null) return c.json(apiError('INVALID_MATERIAL_PRICE', '物资单价必须为空或非负安全整数'), 422);
    const priceDate = validDate(item.priceDate);
    if (priceDate === undefined || (item.taxInclusive !== null && typeof item.taxInclusive !== 'boolean')) return c.json(apiError('INVALID_MATERIAL_PRICE', '物资单价日期或含税标记无效'), 422);
    priceMap.set(allocationId, {
      demandAllocationId: allocationId,
      unitPriceScaled: item.unitPriceScaled,
      source: item.source === null || item.source === undefined ? null : cleanText(item.source),
      priceDate,
      taxInclusive: item.taxInclusive,
    });
  }

  const fixedCosts: FixedCostInput[] = [];
  for (const raw of body.fixedCosts) {
    const item = raw as FixedCostInput;
    const kind = item?.kind;
    const label = cleanText(item?.label);
    const amountFen = safeNonNegativeInteger(item?.amountFen);
    const priceDate = validDate(item?.priceDate);
    if ((kind !== 'construction' && kind !== 'other') || !label || label.length > 120 || amountFen === null || priceDate === undefined || (item.taxInclusive !== null && typeof item.taxInclusive !== 'boolean')) {
      return c.json(apiError('INVALID_FIXED_COST', '施工费/其他费明细格式无效'), 422);
    }
    fixedCosts.push({
      kind,
      label,
      amountFen,
      source: item.source === null || item.source === undefined ? null : cleanText(item.source),
      priceDate,
      taxInclusive: item.taxInclusive,
    });
  }

  const now = new Date().toISOString();
  const actor = c.get('currentUser');
  const nextVersion = expectedVersion + 1;
  const materialLines: Array<{
    id: string;
    allocation: ProjectAllocationDetail;
    price: MaterialPriceInput;
    amountFen: number | null;
  }> = [];
  let knownAmountFen = fixedCosts.reduce((sum, item) => sum + item.amountFen, 0);
  if (!Number.isSafeInteger(knownAmountFen)) return c.json(apiError('AMOUNT_OVERFLOW', '项目估算金额超过安全整数范围'), 422);
  let pricedCount = 0;
  for (const allocation of allocations) {
    const price = priceMap.get(allocation.id) ?? {
      demandAllocationId: allocation.id,
      unitPriceScaled: null,
      source: null,
      priceDate: null,
      taxInclusive: null,
    };
    let amountFen: number | null = null;
    if (price.unitPriceScaled !== null) {
      amountFen = calculateAmountFen(allocation.quantityScaled, price.unitPriceScaled);
      if (amountFen === null) return c.json(apiError('AMOUNT_OVERFLOW', '物资估算金额超过安全整数范围'), 422);
      knownAmountFen += amountFen;
      if (!Number.isSafeInteger(knownAmountFen)) return c.json(apiError('AMOUNT_OVERFLOW', '项目估算金额超过安全整数范围'), 422);
      pricedCount += 1;
    }
    materialLines.push({ id: crypto.randomUUID(), allocation, price, amountFen });
  }
  const missingPriceCount = allocations.length - pricedCount;
  const completenessBasisPoints = Math.floor((pricedCount * 10000) / allocations.length);
  const summary: ProjectCostSummary = { knownAmountFen, missingPriceCount, completenessBasisPoints };
  const response = {
    ok: true as const,
    data: { version: nextVersion, ...summary },
  };
  const costLines = [
    ...materialLines.map((line) => ({
      id: line.id,
      kind: 'material' as const,
      demandAllocationId: line.allocation.id,
      label: line.allocation.material
        ? `${line.allocation.material.name} ${line.allocation.material.model}`
        : line.allocation.rawModel,
      unitPriceScaled: line.price.unitPriceScaled,
      amountFen: line.amountFen,
      source: line.price.source,
      priceDate: line.price.priceDate,
      taxInclusive: line.price.taxInclusive,
    })),
    ...fixedCosts.map((fixed) => ({
      id: crypto.randomUUID(),
      kind: fixed.kind,
      demandAllocationId: null,
      label: fixed.label,
      unitPriceScaled: null,
      amountFen: fixed.amountFen,
      source: fixed.source,
      priceDate: fixed.priceDate,
      taxInclusive: fixed.taxInclusive,
    })),
  ];
  try {
    await writeRepository.replaceCosts({
      projectId: project.id,
      expectedVersion,
      now,
      lines: costLines,
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
      auditAfter: { version: nextVersion, ...summary },
    });
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    const current = await writeRepository.findProject(project.id);
    if (current && current.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('COST_UPDATE_CONFLICT', '估算更新发生冲突，请刷新后重试'), 409);
  }
  return c.json(response);
});

reservePlanningApp.get('/reserve-categories', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlProjectQueryRepository(database).listReserveCategories() } });
});

reservePlanningApp.post('/reserve-categories', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: { key?: unknown; label?: unknown };
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const categoryKey = cleanText(body.key);
  const label = cleanText(body.label);
  if (!categoryKey || categoryKey.length > 80 || !label || label.length > 120) return c.json(apiError('INVALID_RESERVE_CATEGORY', '储备大类 key 或名称无效'), 422);
  const requestBody = { key: categoryKey, label };
  const hash = await requestHash(requestBody);
  const operation = 'reserve-categories.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const actor = c.get('currentUser');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const data: ReserveCategorySummary = { id, key: categoryKey, label, enabled: true, version: 1 };
  const response = { ok: true as const, data };
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlReserveCategoryWriteRepository(database);
  try {
    await repository.createCategory({
      category: data,
      actorId: actor.id,
      now,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    return c.json(apiError('RESERVE_CATEGORY_EXISTS', '储备大类 key 已存在'), 409);
  }
  return c.json(response, 201);
});

reservePlanningApp.get('/category-mappings', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlProjectQueryRepository(database).listCategoryMappings() } });
});

reservePlanningApp.put('/category-mappings/:demandCategory', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: { expectedVersion?: unknown; reserveCategoryId?: unknown };
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const demandCategory = cleanText(c.req.param('demandCategory'));
  const reserveCategoryId = cleanText(body.reserveCategoryId);
  const expectedVersion = body.expectedVersion === null ? null : parseExpectedVersion(body.expectedVersion);
  if (!demandCategory || demandCategory.length > 120 || !reserveCategoryId || (body.expectedVersion !== null && expectedVersion === null)) {
    return c.json(apiError('INVALID_CATEGORY_MAPPING', '需求类别、储备大类或 expectedVersion 无效'), 422);
  }
  const requestBody = { expectedVersion, reserveCategoryId };
  const hash = await requestHash(requestBody);
  const operation = `category-mappings:${demandCategory.toLowerCase()}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlReserveCategoryWriteRepository(database);
  const category = await repository.findCategory(reserveCategoryId);
  if (!category?.enabled) return c.json(apiError('RESERVE_CATEGORY_NOT_FOUND', '储备大类不存在或已停用'), 404);
  const current = await repository.findMapping(demandCategory);
  if (!current && expectedVersion !== null) return c.json(apiError('VERSION_CONFLICT', '类别映射不存在，expectedVersion 应为空'), 409);
  if (current && expectedVersion !== current.version) return c.json(apiError('VERSION_CONFLICT', '类别映射已被修改，请刷新后重试'), 409);

  const actor = c.get('currentUser');
  const now = new Date().toISOString();
  const id = current?.id ?? crypto.randomUUID();
  const nextVersion = current ? current.version + 1 : 1;
  const data: CategoryMappingSummary = { id, demandCategory, reserveCategoryId, version: nextVersion };
  const response = { ok: true as const, data };
  try {
    await repository.upsertMapping({
      mapping: data,
      expectedVersion,
      actorId: actor.id,
      now,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
      before: current,
    });
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    return c.json(apiError('VERSION_CONFLICT', '类别映射已被并发修改，请刷新后重试'), 409);
  }
  return c.json(response);
});

reservePlanningApp.put('/projects/:id/category-allocations', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: Partial<ReplaceCategoryAllocationsRequest>;
  try { body = await c.req.json<Partial<ReplaceCategoryAllocationsRequest>>(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expectedVersion = parseExpectedVersion(body.expectedVersion);
  if (expectedVersion === null || !Array.isArray(body.allocations)) return c.json(apiError('INVALID_CATEGORY_ALLOCATIONS', 'expectedVersion 或分类分摊格式无效'), 422);
  const operation = `projects.category-allocations:${c.req.param('id')}`;
  const requestBody = { expectedVersion, allocations: body.allocations };
  const hash = await requestHash(requestBody);
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const { database } = createCloudflarePersistence(c.env);
  const queryRepository = new SqlProjectQueryRepository(database);
  const writeRepository = new SqlProjectWriteRepository(database);
  const project = await queryRepository.getProjectDetail(c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!canAccessProject(c, project.id)) return c.json(apiError('SCOPE_FORBIDDEN', '当前成员无权修改该项目'), 403);
  if (project.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);

  const costs = project.costLines;
  const knownCosts = new Map(costs.filter((line) => line.amountFen !== null).map((line) => [line.id, line.amountFen as number]));
  const allCosts = new Map(costs.map((line) => [line.id, line]));
  const categories = new Map((await queryRepository.listReserveCategories()).filter((row) => row.enabled).map((row) => [row.id, row]));
  const seenPairs = new Set<string>();
  const sums = new Map<string, number>();
  const normalized: ReplaceCategoryAllocationsRequest['allocations'] = [];
  for (const raw of body.allocations) {
    if (!raw || typeof raw !== 'object') return c.json(apiError('INVALID_CATEGORY_ALLOCATIONS', '分类分摊明细格式无效'), 422);
    const item = raw as { costLineId?: unknown; reserveCategoryId?: unknown; amountFen?: unknown };
    const costLineId = cleanText(item.costLineId);
    const reserveCategoryId = cleanText(item.reserveCategoryId);
    const amountFen = safeNonNegativeInteger(item.amountFen);
    const pair = `${costLineId}\u0000${reserveCategoryId}`;
    if (!costLineId || !reserveCategoryId || amountFen === null || seenPairs.has(pair)) return c.json(apiError('INVALID_CATEGORY_ALLOCATIONS', '分类分摊存在无效或重复明细'), 422);
    const cost = allCosts.get(costLineId);
    if (!cost) return c.json(apiError('COST_LINE_NOT_FOUND', '费用明细不属于该项目'), 422);
    if (cost.amountFen === null) return c.json(apiError('COST_LINE_UNKNOWN_AMOUNT', '未知金额费用不能参与分类金额分摊'), 422);
    if (!categories.has(reserveCategoryId)) return c.json(apiError('RESERVE_CATEGORY_NOT_FOUND', '储备大类不存在或已停用'), 422);
    seenPairs.add(pair);
    sums.set(costLineId, (sums.get(costLineId) ?? 0) + amountFen);
    normalized.push({ costLineId, reserveCategoryId, amountFen });
  }
  for (const [costLineId, amountFen] of knownCosts) {
    if ((sums.get(costLineId) ?? 0) !== amountFen) {
      return c.json(apiError('CATEGORY_AMOUNT_MISMATCH', '每条已知费用的分类分摊合计必须等于该费用金额', {
        costLineId,
        expectedAmountFen: amountFen,
        allocatedAmountFen: sums.get(costLineId) ?? 0,
      }), 422);
    }
  }

  const categoryTotals = new Map<string, number>();
  for (const item of normalized) categoryTotals.set(item.reserveCategoryId, (categoryTotals.get(item.reserveCategoryId) ?? 0) + item.amountFen);
  const categorySummaryItems: ProjectCategorySummary[] = [...categoryTotals].map(([categoryId, amountFen]) => {
    const row = categories.get(categoryId)!;
    return { reserveCategoryId: categoryId, key: row.key, label: row.label, amountFen };
  }).sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  const knownAmountFen = [...knownCosts.values()].reduce((sum, amount) => sum + amount, 0);
  const classifiedAmountFen = normalized.reduce((sum, item) => sum + item.amountFen, 0);
  const actor = c.get('currentUser');
  const now = new Date().toISOString();
  const nextVersion = expectedVersion + 1;
  const response = {
    ok: true as const,
    data: {
      version: nextVersion,
      knownAmountFen,
      classifiedAmountFen,
      unclassifiedAmountFen: Math.max(0, knownAmountFen - classifiedAmountFen),
      categories: categorySummaryItems,
    },
  };
  try {
    await writeRepository.replaceCategoryAllocations({
      projectId: project.id,
      expectedVersion,
      now,
      allocations: normalized.map((item) => ({
        id: crypto.randomUUID(),
        costLineId: item.costLineId,
        reserveCategoryId: item.reserveCategoryId,
        amountFen: item.amountFen,
      })),
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
      auditAfter: response.data,
    });
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    const current = await writeRepository.findProject(project.id);
    if (current && current.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('CATEGORY_ALLOCATION_CONFLICT', '分类分摊更新发生冲突，请刷新后重试'), 409);
  }
  return c.json(response);
});

reservePlanningApp.post('/projects/:id/confirm', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: Partial<ConfirmProjectRequest>;
  try { body = await c.req.json<Partial<ConfirmProjectRequest>>(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expectedVersion = parseExpectedVersion(body.expectedVersion);
  const reason = body.reason === null || body.reason === undefined ? null : cleanText(body.reason);
  if (expectedVersion === null || (reason !== null && reason.length > 500)) return c.json(apiError('INVALID_CONFIRMATION', 'expectedVersion 或确认原因无效'), 422);
  const operation = `projects.confirm:${c.req.param('id')}`;
  const requestBody = { expectedVersion, reason };
  const hash = await requestHash(requestBody);
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const { database } = createCloudflarePersistence(c.env);
  const queryRepository = new SqlProjectQueryRepository(database);
  const writeRepository = new SqlProjectWriteRepository(database);
  const detail = await queryRepository.getProjectDetail(c.req.param('id'));
  if (!detail) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!canAccessProject(c, detail.id)) return c.json(apiError('SCOPE_FORBIDDEN', '当前成员无权确认该项目'), 403);
  if (detail.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  if (detail.allocations.length === 0) return c.json(apiError('PROJECT_EMPTY', '项目没有需求物资分配，不能确认'), 422);

  const actor = c.get('currentUser');
  const now = new Date().toISOString();
  const reserveVersion = detail.reserveVersion + 1;
  const nextVersion = expectedVersion + 1;
  const versionId = crypto.randomUUID();
  const response = {
    ok: true as const,
    data: {
      id: detail.id,
      status: 'confirmed' as const,
      version: nextVersion,
      reserveVersion,
      knownAmountFen: detail.knownAmountFen,
      missingPriceCount: detail.missingPriceCount,
      completenessBasisPoints: detail.completenessBasisPoints,
    },
  };
  try {
    await writeRepository.confirm({
      projectId: detail.id,
      expectedVersion,
      reserveVersion,
      versionId,
      now,
      snapshot: detail,
      knownAmountFen: detail.knownAmountFen,
      missingPriceCount: detail.missingPriceCount,
      completenessBasisPoints: detail.completenessBasisPoints,
      reason,
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
      auditAfter: response.data,
    });
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    const current = await writeRepository.findProject(detail.id);
    if (current && current.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('PROJECT_CONFIRM_CONFLICT', '储备确认发生冲突，请刷新后重试'), 409);
  }
  return c.json(response);
});

reservePlanningApp.get('/projects/:id/history', async (c) => {
  const projectId = c.req.param('id');
  const { database } = createCloudflarePersistence(c.env);
  const items = await new SqlProjectQueryRepository(database).getProjectHistory(projectId);
  if (items === null) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!canAccessProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '当前成员无权访问该项目'), 403);
  return c.json({ ok: true as const, data: { items } });
});
