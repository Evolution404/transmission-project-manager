import { Hono } from 'hono';
import { requireRoles, type AppEnv } from './auth.ts';
import { replayIdempotentResponse, requestHash, requireIdempotencyKey } from './http/idempotent-mutation.ts';
import { apiError } from './http/request-values.ts';
import {
  MAX_EXECUTION_ITEMS as MAX_ITEMS,
  addExecutionDays as addDays,
  cleanExecutionText as cleanText,
  expectedExecutionVersion as expectedVersion,
  hasExecutionProjectAccess as hasProjectAccess,
  nonNegativeExecutionInteger as nonNegativeInteger,
  nullableExecutionText as nullableText,
  positiveExecutionInteger as positiveInteger,
  validExecutionDate as validDate,
} from './project-execution-shared.ts';
import { SqlFinanceQueryRepository } from './repositories/sql-finance-query-repository.ts';
import { SqlTaskImplementationRepository } from './repositories/sql-task-implementation-repository.ts';
import { SqlTaskSettlementRepository } from './repositories/sql-task-settlement-repository.ts';
import { SqlTaskSupplyRepository } from './repositories/sql-task-supply-repository.ts';
import { resolvePersistence } from './runtime/persistence.ts';

export const projectTaskProgressApp = new Hono<AppEnv>();

projectTaskProgressApp.post('/task-material-supply-events', requireRoles('admin', 'project_manager', 'implementation'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const taskMaterialId = cleanText(body.taskMaterialRequirementId), version = expectedVersion(body.expectedSupplyVersion), stage = cleanText(body.stage) as 'reported' | 'shipped' | 'arrived';
  const quantity = positiveInteger(body.quantityScaled), eventDate = validDate(body.eventDate), note = nullableText(body.note, 1000);
  if (!taskMaterialId || version === null || !['reported','shipped','arrived'].includes(stage) || quantity === null || !eventDate || note === undefined) return c.json(apiError('INVALID_SUPPLY_EVENT', '物资供应事件参数无效'), 422);
  const request = { taskMaterialRequirementId: taskMaterialId, expectedSupplyVersion: version, stage, quantityScaled: quantity, eventDate, note };
  const hash = await requestHash(request), operation = 'task-material-supply-events.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const { database } = resolvePersistence(c.env);
  const repository = new SqlTaskSupplyRepository(database);
  const material = await repository.findSupplyState(taskMaterialId);
  if (!material) return c.json(apiError('TASK_MATERIAL_NOT_FOUND', '任务物资不存在'), 404);
  if (!hasProjectAccess(c, material.projectId, material.frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权登记该任务物资供应'), 403);
  if (material.supplyVersion !== version) return c.json(apiError('VERSION_CONFLICT', '任务物资供应状态已变化，请刷新后重试'), 409);
  const totals = material.totals;
  const next = { ...totals };
  if (stage === 'reported') next.reportedQuantityScaled += quantity;
  if (stage === 'shipped') next.shippedQuantityScaled += quantity;
  if (stage === 'arrived') next.arrivedQuantityScaled += quantity;
  if (next.reportedQuantityScaled > material.requiredQuantityScaled || next.shippedQuantityScaled > next.reportedQuantityScaled || next.arrivedQuantityScaled > next.shippedQuantityScaled) {
    return c.json(apiError('SUPPLY_STAGE_ORDER_VIOLATION', '物资供应累计数量必须满足：已到货 <= 已发货 <= 已上报 <= 任务需求量', { requiredQuantityScaled: material.requiredQuantityScaled, totals: next }), 422);
  }
  const actor = c.get('currentUser'), now = new Date().toISOString(), id = crypto.randomUUID();
  const data = { id, taskMaterialRequirementId: taskMaterialId, taskId: material.taskId, stage, quantityScaled: quantity, eventDate, note, supplyVersion: version + 1, totals: next, createdAt: now };
  const response = { ok: true as const, data };
  try {
    await repository.createSupplyEvent({
      event: data,
      beforeTotals: totals,
      expectedSupplyVersion: version,
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    return c.json(apiError('VERSION_CONFLICT', '任务物资供应状态已被并发修改，请刷新后重试'), 409);
  }
  return c.json(response, 201);
});

projectTaskProgressApp.post('/task-implementations', requireRoles('admin', 'project_manager', 'implementation'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const taskId = cleanText(body.taskId), version = expectedVersion(body.expectedImplementationVersion), recordDate = validDate(body.recordDate), note = nullableText(body.note, 1000);
  if (!taskId || version === null || !recordDate || note === undefined || !Array.isArray(body.scopeLines) || body.scopeLines.length > MAX_ITEMS || !Array.isArray(body.materialUsages) || body.materialUsages.length > MAX_ITEMS) return c.json(apiError('INVALID_TASK_IMPLEMENTATION', '任务实施参数无效'), 422);

  const { database } = resolvePersistence(c.env);
  const repository = new SqlTaskImplementationRepository(database);
  const task = await repository.findTaskHeader(taskId);
  if (!task) return c.json(apiError('TASK_NOT_FOUND', '执行任务不存在'), 404);
  if (!hasProjectAccess(c, task.projectId, task.frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权登记该任务实施'), 403);

  const scopeLines: Array<{ taskDemandScopeId: string; completedQuantityScaled: number }> = [], scopeSeen = new Set<string>();
  let scopedQuantity = 0;
  for (const raw of body.scopeLines) {
    if (!raw || typeof raw !== 'object') return c.json(apiError('INVALID_IMPLEMENTATION_SCOPE', '实施需求范围无效'), 422);
    const item = raw as Record<string, unknown>, scopeId = cleanText(item.taskDemandScopeId), quantity = positiveInteger(item.completedQuantityScaled);
    if (!scopeId || quantity === null || scopeSeen.has(scopeId)) return c.json(apiError('INVALID_IMPLEMENTATION_SCOPE', '实施需求范围无效或存在重复'), 422);
    scopeSeen.add(scopeId); scopeLines.push({ taskDemandScopeId: scopeId, completedQuantityScaled: quantity }); scopedQuantity += quantity;
  }
  const completedQuantity = body.completedQuantityScaled === undefined ? scopedQuantity : positiveInteger(body.completedQuantityScaled);
  if (completedQuantity === null || completedQuantity <= 0 || scopedQuantity > completedQuantity) return c.json(apiError('INVALID_IMPLEMENTATION_QUANTITY', '实施完成量必须为正且不小于需求范围完成量'), 422);

  const usages: Array<{ taskMaterialRequirementId: string; quantityScaled: number }> = [], usageSeen = new Set<string>();
  for (const raw of body.materialUsages) {
    if (!raw || typeof raw !== 'object') return c.json(apiError('INVALID_MATERIAL_USAGE', '实施物资使用明细无效'), 422);
    const item = raw as Record<string, unknown>, materialId = cleanText(item.taskMaterialRequirementId), quantity = nonNegativeInteger(item.quantityScaled);
    if (!materialId || quantity === null || usageSeen.has(materialId)) return c.json(apiError('INVALID_MATERIAL_USAGE', '实施物资使用明细无效或存在重复'), 422);
    usageSeen.add(materialId); usages.push({ taskMaterialRequirementId: materialId, quantityScaled: quantity });
  }

  const request = { taskId, expectedImplementationVersion: version, recordDate, completedQuantityScaled: completedQuantity, scopeLines, materialUsages: usages, note };
  const hash = await requestHash(request), operation = 'task-implementations.create'; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (task.implementationVersion !== version) return c.json(apiError('VERSION_CONFLICT', '任务实施状态已变化，请刷新后重试'), 409);

  const state = await repository.loadValidationState(taskId);
  const scopeMap = new Map(state.scopes.map((item) => [item.id, item]));
  for (const line of scopeLines) {
    const scope = scopeMap.get(line.taskDemandScopeId);
    if (!scope) return c.json(apiError('INVALID_IMPLEMENTATION_SCOPE', '实施需求范围不属于任务或存在重复'), 422);
    if (scope.usedQuantityScaled + line.completedQuantityScaled > scope.plannedQuantityScaled) return c.json(apiError('IMPLEMENTATION_EXCEEDS_DEMAND_SCOPE', '实施完成量超过任务需求范围'), 422);
  }
  const plannedLinked = state.scopes.reduce((sum, scope) => sum + scope.plannedQuantityScaled, 0);
  if (plannedLinked === task.plannedQuantityScaled && scopedQuantity !== completedQuantity) return c.json(apiError('IMPLEMENTATION_SCOPE_MISMATCH', '任务范围已全部关联需求时，实施完成量必须与需求范围明细合计一致'), 422);
  if (state.previousCompletedQuantityScaled + completedQuantity > task.plannedQuantityScaled) return c.json(apiError('IMPLEMENTATION_EXCEEDS_TASK', '累计实施完成量超过任务计划量'), 422);

  const materialMap = new Map(state.materials.map((item) => [item.id, item]));
  for (const usage of usages) {
    const material = materialMap.get(usage.taskMaterialRequirementId);
    if (!material) return c.json(apiError('INVALID_MATERIAL_USAGE', '实施物资使用明细不属于任务或存在重复'), 422);
    if (material.usedQuantityScaled + usage.quantityScaled > material.requiredQuantityScaled) return c.json(apiError('MATERIAL_USAGE_EXCEEDS_TASK', '累计实际物资使用量超过任务物资需求，需先做明确范围变更'), 422);
  }

  const actor = c.get('currentUser'), now = new Date().toISOString(), id = crypto.randomUUID();
  const firstImplementationDate = state.firstImplementationDate && state.firstImplementationDate < recordDate ? state.firstImplementationDate : recordDate;
  const data = { id, taskId, recordDate, completedQuantityScaled: completedQuantity, scopeLines, materialUsages: usages, note, implementationVersion: version + 1, createdAt: now };
  const response = { ok: true as const, data };
  try {
    await repository.createImplementation({
      event: data,
      expectedImplementationVersion: version,
      scopeWrites: scopeLines.map((line) => ({ id: crypto.randomUUID(), ...line })),
      usageWrites: usages.map((line) => ({ id: crypto.randomUUID(), ...line })),
      reminder: {
        firstImplementationDate,
        dueDate: addDays(firstImplementationDate, 30),
        status: state.finalSettlementId ? 'closed' : 'open',
        finalSettlementId: state.finalSettlementId,
      },
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    return c.json(apiError('VERSION_CONFLICT', '任务实施状态已被并发修改，请刷新后重试'), 409);
  }
  return c.json(response, 201);
});

projectTaskProgressApp.post('/task-settlements', requireRoles('admin', 'project_manager', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const taskId = cleanText(body.taskId), version = expectedVersion(body.expectedSettlementVersion), settlementDate = validDate(body.settlementDate), amountFen = nonNegativeInteger(body.amountFen), final = body.final === true, note = nullableText(body.note, 1000);
  if (!taskId || version === null || !settlementDate || amountFen === null || note === undefined || !Array.isArray(body.coverage) || body.coverage.length > MAX_ITEMS || !Array.isArray(body.agreementAllocations) || body.agreementAllocations.length > MAX_ITEMS) return c.json(apiError('INVALID_TASK_SETTLEMENT', '任务结算参数无效'), 422);

  const { database } = resolvePersistence(c.env);
  const repository = new SqlTaskSettlementRepository(database);
  const task = await repository.findTaskHeader(taskId);
  if (!task) return c.json(apiError('TASK_NOT_FOUND', '执行任务不存在'), 404);
  if (!hasProjectAccess(c, task.projectId, task.frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权登记该任务结算'), 403);

  const coverage: Array<{ taskDemandScopeId: string; quantityScaled: number }> = [], coverageSeen = new Set<string>();
  let scopedCoverage = 0;
  for (const raw of body.coverage) {
    if (!raw || typeof raw !== 'object') return c.json(apiError('INVALID_SETTLEMENT_COVERAGE', '结算需求范围无效'), 422);
    const item = raw as Record<string, unknown>, scopeId = cleanText(item.taskDemandScopeId), quantity = positiveInteger(item.quantityScaled);
    if (!scopeId || quantity === null || coverageSeen.has(scopeId)) return c.json(apiError('INVALID_SETTLEMENT_COVERAGE', '结算需求范围无效或存在重复'), 422);
    coverageSeen.add(scopeId); coverage.push({ taskDemandScopeId: scopeId, quantityScaled: quantity }); scopedCoverage += quantity;
  }
  const coverageQuantity = body.coverageQuantityScaled === undefined ? scopedCoverage : positiveInteger(body.coverageQuantityScaled);
  if (coverageQuantity === null || coverageQuantity <= 0 || scopedCoverage > coverageQuantity) return c.json(apiError('INVALID_SETTLEMENT_QUANTITY', '结算覆盖量必须为正且不小于需求范围覆盖量'), 422);

  const allocations: Array<{ agreementId: string; amountFen: number }> = [], agreementSeen = new Set<string>();
  let allocationTotal = 0;
  for (const raw of body.agreementAllocations) {
    if (!raw || typeof raw !== 'object') return c.json(apiError('INVALID_SETTLEMENT_AGREEMENT', '结算协议分摊无效'), 422);
    const item = raw as Record<string, unknown>, agreementId = cleanText(item.agreementId), amount = nonNegativeInteger(item.amountFen);
    if (!agreementId || amount === null || agreementSeen.has(agreementId)) return c.json(apiError('INVALID_SETTLEMENT_AGREEMENT', '结算协议分摊无效或重复'), 422);
    agreementSeen.add(agreementId); allocations.push({ agreementId, amountFen: amount }); allocationTotal += amount;
  }
  if (allocations.length && allocationTotal !== amountFen) return c.json(apiError('SETTLEMENT_AGREEMENT_MISMATCH', '结算协议分摊金额必须精确等于结算金额'), 422);

  const request = { taskId, expectedSettlementVersion: version, settlementDate, coverageQuantityScaled: coverageQuantity, amountFen, final, note, coverage, agreementAllocations: allocations };
  const hash = await requestHash(request), operation = 'task-settlements.create'; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (task.settlementVersion !== version) return c.json(apiError('VERSION_CONFLICT', '任务结算状态已变化，请刷新后重试'), 409);

  const state = await repository.loadValidationState(taskId);
  const scopeMap = new Map(state.scopes.map((item) => [item.id, item]));
  for (const line of coverage) {
    const scope = scopeMap.get(line.taskDemandScopeId);
    if (!scope) return c.json(apiError('INVALID_SETTLEMENT_COVERAGE', '结算需求范围不属于任务或存在重复'), 422);
    if (scope.settledQuantityScaled + line.quantityScaled > scope.plannedQuantityScaled) return c.json(apiError('SETTLEMENT_EXCEEDS_DEMAND_SCOPE', '结算覆盖量超过任务需求范围'), 422);
  }
  const plannedLinked = state.scopes.reduce((sum, scope) => sum + scope.plannedQuantityScaled, 0);
  if (plannedLinked === task.plannedQuantityScaled && scopedCoverage !== coverageQuantity) return c.json(apiError('SETTLEMENT_SCOPE_MISMATCH', '任务范围已全部关联需求时，结算覆盖量必须与需求范围明细合计一致'), 422);
  const afterTotal = state.previousCoverageQuantityScaled + coverageQuantity;
  if (afterTotal > task.plannedQuantityScaled) return c.json(apiError('SETTLEMENT_EXCEEDS_TASK', '累计结算覆盖量超过任务计划量'), 422);
  if (final) {
    if (afterTotal !== task.plannedQuantityScaled) return c.json(apiError('FINAL_SETTLEMENT_INCOMPLETE', '最终结算必须覆盖任务全部计划范围'), 422);
    for (const scope of state.scopes) {
      const added = coverage.find((item) => item.taskDemandScopeId === scope.id)?.quantityScaled ?? 0;
      if (scope.settledQuantityScaled + added !== scope.plannedQuantityScaled) return c.json(apiError('FINAL_SETTLEMENT_INCOMPLETE', '最终结算必须完整覆盖全部已关联需求范围', { taskDemandScopeId: scope.id }), 422);
    }
  }

  if (allocations.length) {
    if (!task.frameworkId) return c.json(apiError('PROJECT_FRAMEWORK_REQUIRED', '项目未归属框架，不能填写结算协议分摊'), 422);
    const checked = await new SqlFinanceQueryRepository(database).validateAgreementAllocations(task.frameworkId, allocations, settlementDate, true);
    if (!checked.ok) {
      if (checked.reason === 'not_effective') return c.json(apiError('AGREEMENT_NOT_EFFECTIVE', '结算协议在结算日期无效'), 422);
      return c.json(apiError('AGREEMENT_FRAMEWORK_MISMATCH', '结算协议与项目不属于同一框架'), 422);
    }
  }

  const actor = c.get('currentUser'), now = new Date().toISOString(), id = crypto.randomUUID();
  const data = { id, taskId, settlementDate, coverageQuantityScaled: coverageQuantity, amountFen, final, note, coverage, agreementAllocations: allocations, version: 1, settlementVersion: version + 1, voidedAt: null, voidReason: null, createdAt: now, updatedAt: now };
  const response = { ok: true as const, data };
  try {
    await repository.createSettlement({
      event: data,
      expectedSettlementVersion: version,
      coverageWrites: coverage.map((line) => ({ id: crypto.randomUUID(), ...line })),
      allocationWrites: allocations.map((line) => ({ id: crypto.randomUUID(), ...line })),
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    return c.json(apiError('VERSION_CONFLICT', '任务结算状态已被并发修改，请刷新后重试'), 409);
  }
  return c.json(response, 201);
});

projectTaskProgressApp.post('/task-settlements/:id/void', requireRoles('admin', 'project_manager', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expectedSettlementVersion = expectedVersion(body.expectedSettlementVersion), recordVersion = expectedVersion(body.expectedVersion), reason = cleanText(body.reason);
  if (expectedSettlementVersion === null || recordVersion === null || !reason || reason.length > 1000) return c.json(apiError('INVALID_SETTLEMENT_VOID', '撤销版本或原因无效'), 422);
  const { database } = resolvePersistence(c.env);
  const repository = new SqlTaskSettlementRepository(database);
  const row = await repository.findVoidState(c.req.param('id'));
  if (!row) return c.json(apiError('TASK_SETTLEMENT_NOT_FOUND', '任务结算不存在'), 404);
  if (!hasProjectAccess(c, row.projectId, row.frameworkId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权撤销该任务结算'), 403);
  const request = { expectedSettlementVersion, expectedVersion: recordVersion, reason }, hash = await requestHash(request), operation = `task-settlements.void:${row.id}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  if (row.voidedAt) return c.json(apiError('SETTLEMENT_ALREADY_VOIDED', '该任务结算已撤销'), 409);
  if (row.recordVersion !== recordVersion || row.settlementVersion !== expectedSettlementVersion) return c.json(apiError('VERSION_CONFLICT', '任务结算状态已变化，请刷新后重试'), 409);
  const actor = c.get('currentUser'), now = new Date().toISOString(), response = { ok: true as const, data: { id: row.id, taskId: row.taskId, version: recordVersion + 1, settlementVersion: expectedSettlementVersion + 1, voidedAt: now, voidReason: reason } };
  try {
    await repository.voidSettlement({
      settlementId: row.id,
      taskId: row.taskId,
      expectedRecordVersion: recordVersion,
      expectedSettlementVersion,
      final: row.final,
      firstImplementationDate: row.firstImplementationDate,
      replacementFinalId: row.replacementFinalId,
      reason,
      now,
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
      responseData: response.data,
    });
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    return c.json(apiError('VERSION_CONFLICT', '任务结算已被并发修改，请刷新后重试'), 409);
  }
  return c.json(response);
});
