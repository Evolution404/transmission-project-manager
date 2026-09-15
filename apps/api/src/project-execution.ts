import { Hono } from 'hono';
import { requireRoles, type AppEnv } from './auth.ts';
import { replayIdempotentResponse, requestHash, requireIdempotencyKey } from './http/idempotent-mutation.ts';
import { apiError } from './http/request-values.ts';
import {
  MAX_EXECUTION_ITEMS as MAX_ITEMS,
  cleanExecutionText as cleanText,
  expectedExecutionVersion as expectedVersion,
  hasExecutionProjectAccess as hasProjectAccess,
  nonNegativeExecutionInteger as nonNegativeInteger,
  nullableExecutionText as nullableText,
  parseExecutionQuantityScaled as parseQuantityScaled,
  positiveExecutionInteger as positiveInteger,
  validExecutionDate as validDate,
  validExecutionYear as validYear,
} from './project-execution-shared.ts';
import { SqlProjectReleaseRepository } from './repositories/sql-project-release-repository.ts';
import { SqlProjectTaskRepository } from './repositories/sql-project-task-repository.ts';
import { SqlExecutionQueryRepository } from './repositories/sql-execution-query-repository.ts';
import { SqlDemandRepository } from './repositories/sql-demand-repository.ts';
import { SqlDemandQueryRepository } from './repositories/sql-demand-query-repository.ts';
import { SqlDemandMaterialWriteRepository } from './repositories/sql-demand-material-write-repository.ts';
import { SqlReserveProjectQueryRepository } from './repositories/sql-reserve-project-query-repository.ts';
import { SqlReserveProjectWriteRepository } from './repositories/sql-reserve-project-write-repository.ts';
import { resolvePersistence as createCloudflarePersistence } from './runtime/persistence.ts';

function normalizeDemandMaterials(body: Record<string, unknown>): Array<{ rawModel: string; materialId: string | null; quantityScaled: number; unit: string | null }> | null {
  const source = Array.isArray(body.materials)
    ? body.materials
    : body.materialModel !== undefined || body.materialQuantity !== undefined
      ? [{ rawModel: body.materialModel, materialId: null, quantityScaled: parseQuantityScaled(body.materialQuantity), unit: body.unit }]
      : [];
  if (source.length > MAX_ITEMS) return null;
  const items: Array<{ rawModel: string; materialId: string | null; quantityScaled: number; unit: string | null }> = [];
  for (const raw of source) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const rawModel = cleanText(item.rawModel ?? item.materialModel);
    const materialId = item.materialId === null || item.materialId === undefined ? null : cleanText(item.materialId);
    const quantityScaled = positiveInteger(item.quantityScaled) ?? parseQuantityScaled(item.materialQuantity);
    const unit = item.unit === null || item.unit === undefined || item.unit === '' ? null : cleanText(item.unit);
    if (!rawModel || rawModel.length > 160 || quantityScaled === null || (materialId !== null && !materialId) || (unit !== null && unit.length > 40)) return null;
    items.push({ rawModel, materialId, quantityScaled, unit });
  }
  return items;
}

function parseProjectMaterials(value: unknown, allowIds: boolean) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  const parsed: Array<{
    id: string | null;
    materialId: string | null;
    model: string;
    unit: string;
    requiredQuantityScaled: number;
    unitPriceScaled: number | null;
    reserveCategoryId: string | null;
  }> = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const id = item.id === null || item.id === undefined ? null : cleanText(item.id);
    const materialId = item.materialId === null || item.materialId === undefined ? null : cleanText(item.materialId);
    const model = cleanText(item.model);
    const unit = cleanText(item.unit);
    const quantity = positiveInteger(item.requiredQuantityScaled);
    const unitPrice = item.unitPriceScaled === null || item.unitPriceScaled === undefined ? null : nonNegativeInteger(item.unitPriceScaled);
    const categoryId = item.reserveCategoryId === null || item.reserveCategoryId === undefined ? null : cleanText(item.reserveCategoryId);
    if ((!allowIds && id !== null) || (id !== null && (!id || ids.has(id))) || quantity === null || (unitPrice === null && item.unitPriceScaled !== null && item.unitPriceScaled !== undefined)) return null;
    if ((materialId !== null && !materialId) || (categoryId !== null && !categoryId)) return null;
    if (id) ids.add(id);
    parsed.push({ id, materialId, model, unit, requiredQuantityScaled: quantity, unitPriceScaled: unitPrice, reserveCategoryId: categoryId });
  }
  return parsed;
}

function parseDemandIds(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const id = cleanText(raw);
    if (!id || seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export const projectExecutionApp = new Hono<AppEnv>();



projectExecutionApp.post('/demands/:id/materials', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion), materials = normalizeDemandMaterials(body);
  if (version === null || !materials || materials.length < 1) return c.json(apiError('INVALID_DEMAND_MATERIALS', 'expectedVersion 或需求物资子明细无效'), 422);
  const demandId = c.req.param('id');
  const { database } = createCloudflarePersistence(c.env);
  const writeRepository = new SqlDemandMaterialWriteRepository(database);
  const current = await writeRepository.findState(demandId);
  if (!current) return c.json(apiError('DEMAND_NOT_FOUND', '需求不存在'), 404);
  const request = { expectedVersion: version, materials }, hash = await requestHash(request), operation = `demands.materials.add:${demandId}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (current.version !== version) return c.json(apiError('VERSION_CONFLICT', '需求已被修改，请刷新后重试'), 409);
  const materialIds = [...new Set(materials.flatMap((item) => item.materialId ? [item.materialId] : []))];
  if (materialIds.length) {
    const enabled = await new SqlDemandRepository(database).findEnabledMaterials(materialIds);
    if (enabled.length !== materialIds.length) return c.json(apiError('MATERIAL_NOT_FOUND', '需求物资引用的标准物资不存在或已停用'), 422);
  }
  const actor = c.get('currentUser'), now = new Date().toISOString();
  const rows = materials.map((item) => ({ id: crypto.randomUUID(), ...item }));
  const responseData = await new SqlDemandQueryRepository(database).getById(demandId);
  if (!responseData) return c.json(apiError('DEMAND_NOT_FOUND', '需求不存在'), 404);
  const data = {
    ...responseData,
    version: version + 1,
    updatedAt: now,
    materials: [...responseData.materials, ...rows.map((item) => ({ id: item.id, rawModel: item.rawModel, quantityScaled: item.quantityScaled, unit: item.unit, material: null, version: 1 }))],
  };
  const response = { ok: true as const, data };
  try {
    await writeRepository.append({
      demandId,
      expectedVersion: version,
      rows,
      now,
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    const latest = await writeRepository.findState(demandId);
    if (latest && latest.version !== version) return c.json(apiError('VERSION_CONFLICT', '需求已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('DEMAND_MATERIAL_CONFLICT', '需求物资写入发生冲突'), 409);
  }
  return c.json(response);
});
projectExecutionApp.post('/reserve-projects', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const name = cleanText(body.name), year = validYear(body.year), owner = nullableText(body.owner, 80);
  const parsedDemandIds = parseDemandIds(body.demandIds ?? []), parsedMaterials = parseProjectMaterials(body.materials ?? [], false);
  if (!name || name.length > 160 || year === undefined || owner === undefined || !parsedDemandIds || !parsedMaterials) return c.json(apiError('INVALID_PROJECT', '项目名称、年度、需求关联或项目物资无效'), 422);
  const actor = c.get('currentUser');
  if (actor.role !== 'admin' && !actor.scopes.some((scope) => scope.type === 'all')) return c.json(apiError('SCOPE_FORBIDDEN', '当前成员没有创建新项目的全局范围'), 403);
  const { database } = createCloudflarePersistence(c.env);
  const queryRepository = new SqlReserveProjectQueryRepository(database);
  const writeRepository = new SqlReserveProjectWriteRepository(database);
  if (!await queryRepository.validateDemandIds(parsedDemandIds)) return c.json(apiError('INVALID_PROJECT', '项目名称、年度、需求关联或项目物资无效'), 422);
  const materials = await queryRepository.resolveMaterials(parsedMaterials);
  if (!materials) return c.json(apiError('INVALID_PROJECT', '项目名称、年度、需求关联或项目物资无效'), 422);
  const demandIds = [...parsedDemandIds];
  const request = { name, year, owner, demandIds, materials }, hash = await requestHash(request), operation = 'reserve-projects.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const id = crypto.randomUUID(), now = new Date().toISOString();
  const demandLinks = demandIds.map((demandId) => ({ id: crypto.randomUUID(), demandId }));
  const materialRows = materials.map((item) => ({ id: crypto.randomUUID(), item }));
  const response = { ok: true as const, data: {
    id, name, year, owner, status: 'draft' as const, reserveVersion: 0, frameworkId: null, version: 1,
    demandLinks: demandLinks.map((link) => ({ id: link.id, demandId: link.demandId })),
    materialRequirements: materialRows.map(({ id: materialId, item }) => ({
      id: materialId, projectId: id, materialId: item.materialId, model: item.model, unit: item.unit,
      requiredQuantityScaled: item.requiredQuantityScaled, unitPriceScaled: item.unitPriceScaled, amountFen: item.amountFen,
      reserveCategoryId: item.reserveCategoryId, reserveCategory: null, version: 1, createdAt: now, updatedAt: now,
    })),
    knownMaterialAmountFen: materialRows.reduce((sum, row) => sum + (row.item.amountFen ?? 0), 0),
    missingPriceCount: materialRows.filter((row) => row.item.amountFen === null).length,
    materialPriceCompletenessBasisPoints: materialRows.length === 0 ? 10000 : Math.floor((materialRows.filter((row) => row.item.amountFen !== null).length * 10000) / materialRows.length),
    createdAt: now, updatedAt: now,
  } };
  try {
    await writeRepository.create({
      project: { id, name, year, owner }, demandLinks, materials: materialRows,
      actorId: actor.id, auditId: crypto.randomUUID(), idempotencyKey: key, operation, requestHash: hash,
      responseJson: JSON.stringify(response), now, auditAfter: request,
    });
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    return c.json(apiError('PROJECT_CREATE_CONFLICT', '储备项目创建发生冲突'), 409);
  }
  const actual = await queryRepository.find(id);
  return c.json({ ok: true as const, data: actual! }, 201);
});
projectExecutionApp.get('/reserve-projects', async (c) => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? '50')));
  const { database } = createCloudflarePersistence(c.env);
  const items = (await new SqlReserveProjectQueryRepository(database).list(limit))
    .filter((project) => hasProjectAccess(c, project.id, project.frameworkId));
  return c.json({ ok: true as const, data: { items, nextCursor: null } });
});

projectExecutionApp.get('/reserve-projects/:id', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  const project = await new SqlReserveProjectQueryRepository(database).find(c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!hasProjectAccess(c, project.id, project.frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目'), 403);
  return c.json({ ok: true as const, data: project });
});

projectExecutionApp.put('/reserve-projects/:id/demands', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion), parsedDemandIds = parseDemandIds(body.demandIds);
  if (version === null || !parsedDemandIds) return c.json(apiError('INVALID_PROJECT_DEMANDS', 'expectedVersion 或需求关联无效'), 422);
  const { database } = createCloudflarePersistence(c.env);
  const queryRepository = new SqlReserveProjectQueryRepository(database);
  const writeRepository = new SqlReserveProjectWriteRepository(database);
  if (!await queryRepository.validateDemandIds(parsedDemandIds)) return c.json(apiError('INVALID_PROJECT_DEMANDS', 'expectedVersion 或需求关联无效'), 422);
  const demandIds = [...parsedDemandIds];
  const project = await queryRepository.findState(c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!hasProjectAccess(c, project.id, project.frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权修改该项目'), 403);
  const request = { expectedVersion: version, demandIds }, hash = await requestHash(request), operation = `reserve-projects.demands:${project.id}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (project.version !== version) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const detail = await queryRepository.find(project.id);
  const currentLinks = detail?.demandLinks ?? [];
  const nextSet = new Set(demandIds), usedDemandIds = new Set(await queryRepository.listUsedDemandIds(project.id));
  for (const link of currentLinks) {
    if (!nextSet.has(link.demandId) && usedDemandIds.has(link.demandId)) {
      return c.json(apiError('PROJECT_DEMAND_PROTECTED', '已被执行任务引用的需求不能从项目中移除', { demandId: link.demandId }), 422);
    }
  }
  const actor = c.get('currentUser'), now = new Date().toISOString();
  const response = { ok: true as const, data: { projectId: project.id, version: version + 1, demandIds } };
  try {
    await writeRepository.replaceDemands({
      projectId: project.id, expectedVersion: version, beforeDemandIds: currentLinks.map((item) => item.demandId),
      demandLinks: demandIds.map((demandId) => ({ id: crypto.randomUUID(), demandId })),
      actorId: actor.id, auditId: crypto.randomUUID(), idempotencyKey: key, operation, requestHash: hash,
      responseJson: JSON.stringify(response), now,
    });
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
  }
  return c.json(response);
});
projectExecutionApp.put('/reserve-projects/:id/materials', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion), reason = cleanText(body.reason), parsedMaterials = parseProjectMaterials(body.materials, true);
  if (version === null || !reason || reason.length > 500 || !parsedMaterials) return c.json(apiError('INVALID_PROJECT_MATERIALS', 'expectedVersion、调整原因或项目物资无效'), 422);
  const { database } = createCloudflarePersistence(c.env);
  const queryRepository = new SqlReserveProjectQueryRepository(database);
  const writeRepository = new SqlReserveProjectWriteRepository(database);
  const materials = await queryRepository.resolveMaterials(parsedMaterials);
  if (!materials) return c.json(apiError('INVALID_PROJECT_MATERIALS', 'expectedVersion、调整原因或项目物资无效'), 422);
  const project = await queryRepository.findState(c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!hasProjectAccess(c, project.id, project.frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权修改该项目'), 403);
  const request = { expectedVersion: version, reason, materials }, hash = await requestHash(request), operation = `reserve-projects.materials:${project.id}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (project.version !== version) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const before = await queryRepository.listCurrentMaterials(project.id), beforeById = new Map(before.map((row) => [row.id, row]));
  const assignedById = await queryRepository.getAssignedMaterialQuantities(project.id);
  const incomingById = new Map(materials.filter((item) => item.id).map((item) => [item.id!, item]));
  for (const old of before) {
    const protectedQuantity = assignedById.get(old.id) ?? 0;
    const next = incomingById.get(old.id);
    if (protectedQuantity > 0 && (!next || next.requiredQuantityScaled < protectedQuantity || next.model !== old.model || next.unit !== old.unit)) {
      return c.json(apiError('PROJECT_MATERIAL_PROTECTED', '项目物资已分配到执行任务，不能删除、换型或缩减到任务分配量以下', {
        projectMaterialRequirementId: old.id, protectedQuantityScaled: protectedQuantity, requestedQuantityScaled: next?.requiredQuantityScaled ?? 0,
      }), 422);
    }
  }
  for (const item of materials) if (item.id && !beforeById.has(item.id)) return c.json(apiError('PROJECT_MATERIAL_NOT_FOUND', '项目物资明细不属于当前项目'), 422);
  const actor = c.get('currentUser'), now = new Date().toISOString();
  const normalizedRows = materials.map((item) => ({ id: item.id ?? crypto.randomUUID(), item }));
  const after = normalizedRows.map(({ id, item }) => ({
    id, projectId: project.id, materialId: item.materialId, model: item.model, unit: item.unit,
    requiredQuantityScaled: item.requiredQuantityScaled, unitPriceScaled: item.unitPriceScaled, amountFen: item.amountFen,
    reserveCategoryId: item.reserveCategoryId, version: (item.id ? beforeById.get(item.id)?.version ?? 0 : 0) + 1,
  }));
  const response = { ok: true as const, data: { projectId: project.id, version: version + 1, materialRequirements: after } };
  try {
    await writeRepository.replaceMaterials({
      projectId: project.id, expectedVersion: version, reason, revisionId: crypto.randomUUID(), before, after,
      materials: normalizedRows.map((row) => ({ id: row.id, existing: row.item.id !== null, item: row.item })),
      actorId: actor.id, auditId: crypto.randomUUID(), idempotencyKey: key, operation, requestHash: hash,
      responseJson: JSON.stringify(response), now,
    });
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    const latest = await queryRepository.findState(project.id);
    if (latest && latest.version !== version) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('PROJECT_MATERIAL_CONFLICT', '项目物资调整发生冲突'), 409);
  }
  return c.json({ ok: true as const, data: (await queryRepository.find(project.id))! });
});

projectExecutionApp.get('/reserve-projects/:id/material-revisions', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlReserveProjectQueryRepository(database);
  const project = await repository.findState(c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!hasProjectAccess(c, project.id, project.frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目'), 403);
  return c.json({ ok: true as const, data: { items: await repository.listMaterialRevisions(project.id) } });
});

projectExecutionApp.post('/reserve-projects/:id/confirm', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion), reason = nullableText(body.reason, 500);
  if (version === null || reason === undefined) return c.json(apiError('INVALID_CONFIRMATION', 'expectedVersion 或确认原因无效'), 422);
  const { database } = createCloudflarePersistence(c.env);
  const queryRepository = new SqlReserveProjectQueryRepository(database);
  const writeRepository = new SqlReserveProjectWriteRepository(database);
  const project = await queryRepository.findState(c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!hasProjectAccess(c, project.id, project.frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权确认该项目'), 403);
  const request = { expectedVersion: version, reason }, hash = await requestHash(request), operation = `reserve-projects.confirm:${project.id}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (project.version !== version) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const detail = await queryRepository.find(project.id);
  if (!detail) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  const actor = c.get('currentUser'), now = new Date().toISOString(), reserveVersion = project.reserveVersion + 1, nextVersion = version + 1;
  const response = { ok: true as const, data: { projectId: project.id, version: nextVersion, reserveVersion, status: 'confirmed' as const } };
  try {
    await writeRepository.confirm({
      projectId: project.id, expectedVersion: version, previousReserveVersion: project.reserveVersion, reserveVersion,
      versionId: crypto.randomUUID(), snapshot: detail, reason,
      actorId: actor.id, auditId: crypto.randomUUID(), idempotencyKey: key, operation, requestHash: hash,
      responseJson: JSON.stringify(response), now, auditAfter: response.data,
    });
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    return c.json(apiError('VERSION_CONFLICT', '项目确认发生并发冲突，请刷新后重试'), 409);
  }
  return c.json(response);
});

projectExecutionApp.post('/project-releases', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const projectId = cleanText(body.projectId), version = expectedVersion(body.expectedProjectVersion), releaseDate = validDate(body.releaseDate), note = nullableText(body.note, 1000);
  if (!projectId || version === null || !releaseDate || note === undefined) return c.json(apiError('INVALID_PROJECT_RELEASE', '项目出库参数无效'), 422);
  const request = { projectId, expectedProjectVersion: version, releaseDate, note }, hash = await requestHash(request), operation = 'project-releases.create';
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlProjectReleaseRepository(database);
  const project = await repository.findProject(projectId);
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (!hasProjectAccess(c, projectId, project.frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权对该项目出库'), 403);
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (project.version !== version) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  if (project.status !== 'confirmed' || project.reserveVersion < 1) return c.json(apiError('PROJECT_NOT_CONFIRMED', '项目必须先确认储备版本才能出库'), 422);
  const existing = await repository.findProjectReleaseId(projectId);
  if (existing) return c.json(apiError('PROJECT_ALREADY_RELEASED', '该项目已经完成项目级出库'), 409);
  const snapshot = await repository.loadSnapshot(projectId, version, project.reserveVersion);
  const actor = c.get('currentUser'), now = new Date().toISOString(), id = crypto.randomUUID(), nextVersion = version + 1;
  const data = { id, projectId, releaseDate, note, projectVersionSnapshot: version, reserveVersionSnapshot: project.reserveVersion, projectVersion: nextVersion, snapshot, createdAt: now };
  const response = { ok: true as const, data };
  try {
    await repository.createRelease({
      release: data,
      expectedProjectVersion: version,
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    const latest = await repository.findProject(projectId);
    if (latest && latest.version !== version) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('PROJECT_RELEASE_CONFLICT', '项目出库发生冲突'), 409);
  }
  return c.json(response, 201);
});

projectExecutionApp.get('/project-releases', async (c) => {
  const projectId = cleanText(c.req.query('projectId'));
  if (!projectId) return c.json(apiError('PROJECT_REQUIRED', 'projectId 不能为空'), 400);
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlProjectReleaseRepository(database);
  const project = await repository.findProject(projectId);
  if (!hasProjectAccess(c, projectId, project?.frameworkId ?? null)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目出库'), 403);
  return c.json({ ok: true as const, data: { items: await repository.listReleases(projectId) } });
});

projectExecutionApp.post('/project-tasks', requireRoles('admin', 'project_manager', 'implementation'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const projectId = cleanText(body.projectId), projectVersion = expectedVersion(body.expectedProjectVersion), name = cleanText(body.name);
  const description = nullableText(body.description, 1000), scopeText = nullableText(body.scopeText, 1000), owner = nullableText(body.owner, 120), plannedDate = validDate(body.plannedDate);
  const plannedQuantity = positiveInteger(body.plannedQuantityScaled), unit = cleanText(body.unit);
  if (!projectId || projectVersion === null || !name || name.length > 160 || description === undefined || scopeText === undefined || owner === undefined || plannedDate === undefined || plannedQuantity === null || !unit || unit.length > 40) {
    return c.json(apiError('INVALID_PROJECT_TASK', '执行任务参数无效'), 422);
  }
  if (!Array.isArray(body.demandScopes) || body.demandScopes.length > MAX_ITEMS || !Array.isArray(body.materials) || body.materials.length > MAX_ITEMS) return c.json(apiError('INVALID_PROJECT_TASK', '任务需求范围或任务物资格式无效'), 422);

  const demandScopes: Array<{ demandId: string; quantityScaled: number }> = [];
  const demandSeen = new Set<string>();
  let linkedPlanned = 0;
  for (const raw of body.demandScopes) {
    if (!raw || typeof raw !== 'object') return c.json(apiError('INVALID_TASK_DEMAND_SCOPE', '任务需求范围无效'), 422);
    const item = raw as Record<string, unknown>, demandId = cleanText(item.demandId), quantity = positiveInteger(item.quantityScaled);
    if (!demandId || quantity === null || demandSeen.has(demandId)) return c.json(apiError('INVALID_TASK_DEMAND_SCOPE', '任务需求范围无效或重复'), 422);
    demandSeen.add(demandId); demandScopes.push({ demandId, quantityScaled: quantity }); linkedPlanned += quantity;
    if (!Number.isSafeInteger(linkedPlanned)) return c.json(apiError('QUANTITY_OVERFLOW', '任务范围数量超出安全整数范围'), 422);
  }
  if (linkedPlanned > plannedQuantity) return c.json(apiError('TASK_DEMAND_SCOPE_EXCEEDS_PLAN', '任务需求范围数量不能超过任务计划数量'), 422);

  const requestedMaterials: Array<{ projectMaterialRequirementId: string; quantityScaled: number }> = [];
  const materialSeen = new Set<string>();
  for (const raw of body.materials) {
    if (!raw || typeof raw !== 'object') return c.json(apiError('INVALID_TASK_MATERIAL', '任务物资无效'), 422);
    const item = raw as Record<string, unknown>, requirementId = cleanText(item.projectMaterialRequirementId), quantity = positiveInteger(item.quantityScaled);
    if (!requirementId || quantity === null || materialSeen.has(requirementId)) return c.json(apiError('INVALID_TASK_MATERIAL', '任务物资必须引用当前项目有效物资且不能重复'), 422);
    materialSeen.add(requirementId); requestedMaterials.push({ projectMaterialRequirementId: requirementId, quantityScaled: quantity });
  }

  const request = { projectId, expectedProjectVersion: projectVersion, name, description, scopeText, owner, plannedDate, plannedQuantityScaled: plannedQuantity, unit, demandScopes, materials: requestedMaterials };
  const hash = await requestHash(request), operation = 'project-tasks.create';
  const { database } = createCloudflarePersistence(c.env);
  const releaseRepository = new SqlProjectReleaseRepository(database);
  const taskRepository = new SqlProjectTaskRepository(database);
  const project = await releaseRepository.findProject(projectId);
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (!hasProjectAccess(c, projectId, project.frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权创建该项目执行任务'), 403);
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (project.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const releaseId = await releaseRepository.findProjectReleaseId(projectId);
  if (!releaseId) return c.json(apiError('PROJECT_NOT_RELEASED', '项目级出库完成后才能创建正式执行任务'), 422);

  const linkedDemandIds = new Set(await taskRepository.listLinkedDemandIds(projectId));
  if (demandScopes.some((item) => !linkedDemandIds.has(item.demandId))) return c.json(apiError('DEMAND_NOT_LINKED_TO_PROJECT', '任务只能关联项目已关联的需求'), 422);

  const projectMaterials = await taskRepository.listProjectMaterialAvailability(projectId);
  const projectMaterialMap = new Map(projectMaterials.map((item) => [item.id, item]));
  const taskMaterials = requestedMaterials.map((item) => ({ ...item, source: projectMaterialMap.get(item.projectMaterialRequirementId) ?? null }));
  if (taskMaterials.some((item) => item.source === null)) return c.json(apiError('INVALID_TASK_MATERIAL', '任务物资必须引用当前项目有效物资且不能重复'), 422);
  for (const item of taskMaterials) {
    const source = item.source!;
    const after = source.assignedQuantityScaled + item.quantityScaled;
    if (after > source.requiredQuantityScaled) return c.json(apiError('TASK_MATERIAL_EXCEEDS_PROJECT', '任务物资分配合计超过项目当前物资需求，需先调整项目物资', { projectMaterialRequirementId: item.projectMaterialRequirementId, availableQuantityScaled: source.requiredQuantityScaled - source.assignedQuantityScaled }), 422);
  }

  const actor = c.get('currentUser'), now = new Date().toISOString(), id = crypto.randomUUID(), nextProjectVersion = projectVersion + 1;
  const scopeRows = demandScopes.map((item) => ({ id: crypto.randomUUID(), ...item }));
  const materialRows = taskMaterials.map((item) => ({ id: crypto.randomUUID(), ...item, source: item.source! }));
  const data = {
    id, projectId, projectReleaseId: releaseId, name, description, scopeText, owner, plannedDate, plannedQuantityScaled: plannedQuantity, unit,
    version: 1, implementationVersion: 1, settlementVersion: 1, projectVersion: nextProjectVersion,
    demandScopes: scopeRows.map((item) => ({ id: item.id, taskId: id, demandId: item.demandId, plannedQuantityScaled: item.quantityScaled })),
    materials: materialRows.map((item) => ({ id: item.id, taskId: id, projectMaterialRequirementId: item.projectMaterialRequirementId, materialId: item.source.materialId, model: item.source.model, unit: item.source.unit, requiredQuantityScaled: item.quantityScaled, supplyVersion: 1, createdAt: now, updatedAt: now })),
    createdAt: now, updatedAt: now,
  };
  const response = { ok: true as const, data };
  try {
    await taskRepository.createTask({
      task: data,
      expectedProjectVersion: projectVersion,
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    const latest = await releaseRepository.findProject(projectId);
    if (latest && latest.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('TASK_CREATE_CONFLICT', '执行任务创建发生冲突'), 409);
  }
  return c.json(response, 201);
});

projectExecutionApp.get('/project-tasks', async (c) => {
  const projectId = cleanText(c.req.query('projectId'));
  if (!projectId) return c.json(apiError('PROJECT_REQUIRED', 'projectId 不能为空'), 400);
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlExecutionQueryRepository(database);
  const project = await repository.findProjectHeader(projectId);
  if (!hasProjectAccess(c, projectId, project?.frameworkId ?? null)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目任务'), 403);
  return c.json({ ok: true as const, data: { items: await repository.listProjectTasks(projectId) } });
});
