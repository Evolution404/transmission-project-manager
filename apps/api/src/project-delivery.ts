import { Hono } from 'hono';
import { requireRoles, type AppEnv } from './auth.ts';
import { replayIdempotentResponse, requestHash, requireIdempotencyKey } from './http/idempotent-mutation.ts';
import { apiError } from './http/request-values.ts';
import {
  MAX_EXECUTION_ITEMS as MAX_ITEMS,
  cleanExecutionText as cleanText,
  expectedExecutionVersion as expectedVersion,
  hasExecutionProjectAccess as hasProjectAccess,
  nullableExecutionText as nullableText,
  positiveExecutionInteger as positiveInteger,
  validExecutionDate as validDate,
} from './project-execution-shared.ts';
import { SqlExecutionQueryRepository } from './repositories/sql-execution-query-repository.ts';
import { SqlProjectReleaseRepository } from './repositories/sql-project-release-repository.ts';
import { SqlProjectTaskRepository } from './repositories/sql-project-task-repository.ts';
import { resolvePersistence } from './runtime/persistence.ts';

export const projectDeliveryApp = new Hono<AppEnv>();

projectDeliveryApp.post('/project-releases', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const projectId = cleanText(body.projectId), version = expectedVersion(body.expectedProjectVersion), releaseDate = validDate(body.releaseDate), note = nullableText(body.note, 1000);
  if (!projectId || version === null || !releaseDate || note === undefined) return c.json(apiError('INVALID_PROJECT_RELEASE', '项目出库参数无效'), 422);
  const request = { projectId, expectedProjectVersion: version, releaseDate, note }, hash = await requestHash(request), operation = 'project-releases.create';
  const { database } = resolvePersistence(c.env);
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

projectDeliveryApp.get('/project-releases', async (c) => {
  const projectId = cleanText(c.req.query('projectId'));
  if (!projectId) return c.json(apiError('PROJECT_REQUIRED', 'projectId 不能为空'), 400);
  const { database } = resolvePersistence(c.env);
  const repository = new SqlProjectReleaseRepository(database);
  const project = await repository.findProject(projectId);
  if (!hasProjectAccess(c, projectId, project?.frameworkId ?? null)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目出库'), 403);
  return c.json({ ok: true as const, data: { items: await repository.listReleases(projectId) } });
});

projectDeliveryApp.post('/project-tasks', requireRoles('admin', 'project_manager', 'implementation'), async (c) => {
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
  const { database } = resolvePersistence(c.env);
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

projectDeliveryApp.get('/project-tasks', async (c) => {
  const projectId = cleanText(c.req.query('projectId'));
  if (!projectId) return c.json(apiError('PROJECT_REQUIRED', 'projectId 不能为空'), 400);
  const { database } = resolvePersistence(c.env);
  const repository = new SqlExecutionQueryRepository(database);
  const project = await repository.findProjectHeader(projectId);
  if (!hasProjectAccess(c, projectId, project?.frameworkId ?? null)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目任务'), 403);
  return c.json({ ok: true as const, data: { items: await repository.listProjectTasks(projectId) } });
});
