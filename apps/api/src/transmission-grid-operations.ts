import { Hono } from 'hono';
import type { LineTowerPositionSummary, TransmissionLineSummary } from '@tpm/shared';
import { normalizeTowerNo } from '@tpm/shared';
import { requireRoles, type AppEnv } from './auth.ts';
import { importedTowerRanks } from './domain/tower-ordering.ts';
import { beginIdempotentMutation as beginMutation, replayIdempotentMutation as replay } from './http/idempotent-mutation.ts';
import { apiError, boolValue, cleanText, intValue } from './http/request-values.ts';
import { masterDataRepository, masterDataWriteRepository } from './master-data-context.ts';
import type { CommitSingleMasterDataInput } from './ports/master-data-write-repository';
import { gridConstraintMessages } from './transmission-grid-errors.ts';

export const transmissionGridOperationsApp = new Hono<AppEnv>();

transmissionGridOperationsApp.get('/master/lines/:id/name-history', async (c) => {
  const id = c.req.param('id');
  const record = await masterDataWriteRepository(c).findRecord('line', id);
  if (!record) return c.json(apiError('MASTER_DATA_NOT_FOUND', '线路不存在'), 404);
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listLineNameHistory(id) } });
});

transmissionGridOperationsApp.get('/master/towers/:id/number-history', async (c) => {
  const id = c.req.param('id');
  const record = await masterDataWriteRepository(c).findRecord('tower-position', id);
  if (!record) return c.json(apiError('MASTER_DATA_NOT_FOUND', '杆塔不存在'), 404);
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listTowerPositionNoHistory(id) } });
});

transmissionGridOperationsApp.post('/master/lines/:id/rename', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const mutation = await beginMutation(c, body); if (mutation instanceof Response) return mutation;
  const id = c.req.param('id'), repository = masterDataWriteRepository(c);
  const before = await repository.findRecord('line', id);
  if (!before) return c.json(apiError('MASTER_DATA_NOT_FOUND', '线路不存在'), 404);
  const expectedVersion = intValue(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER);
  if (expectedVersion === null) return c.json(apiError('INVALID_VERSION', 'expectedVersion 必须为正整数'), 422);
  if (Number(before.version) !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '数据已变化，请刷新后重试'), 409);
  const lineName = cleanText(body.lineName, 200);
  if (!lineName) return c.json(apiError('INVALID_LINE_NAME', '线路新名称不能为空'), 422);
  if (lineName === before.line_name) return c.json(apiError('RENAME_NO_CHANGE', '线路新名称与当前名称相同'), 422);
  const reason = body.reason === undefined || body.reason === null ? null : cleanText(body.reason, 500) || null;
  const parent = await repository.findVoltageParent(String(before.voltage_level_id));
  if (!parent) return c.json(apiError('VOLTAGE_LEVEL_NOT_FOUND', gridConstraintMessages.VOLTAGE_LEVEL_NOT_FOUND!), 422);
  const data: TransmissionLineSummary = {
    id,
    voltageLevelId: String(before.voltage_level_id),
    voltageLevelName: parent.displayName,
    lineCode: before.line_code === null ? null : String(before.line_code),
    lineName,
    enabled: Number(before.enabled) === 1,
    version: expectedVersion + 1,
    towerOrderVersion: Number(before.tower_order_version),
    towerCount: await repository.countLineTowers(id),
  };
  const response = { ok: true as const, data }, now = new Date().toISOString();
  try {
    await repository.commitLineRename({
      id, expectedVersion, lineName, historyId: crypto.randomUUID(), reason,
      mutation: { key: mutation.key, actorId: c.get('currentUser').id, operation: mutation.operation, hash: mutation.hash, responseJson: JSON.stringify(response), statusCode: 200, now, auditId: crypto.randomUUID() },
      audit: { action: 'master.lines.rename', objectType: 'transmission_lines', before, after: data },
    });
  } catch (cause) {
    const raced = await replay(c, mutation); if (raced) return raced;
    if (String(cause).includes('idempotency_records.request_hash')) return c.json(apiError('VERSION_CONFLICT', '数据已变化，请刷新后重试'), 409);
    throw cause;
  }
  return c.json(response, 200);
});

transmissionGridOperationsApp.post('/master/towers/:id/rename', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const mutation = await beginMutation(c, body); if (mutation instanceof Response) return mutation;
  const id = c.req.param('id'), repository = masterDataWriteRepository(c);
  const before = await repository.findRecord('tower-position', id);
  if (!before) return c.json(apiError('MASTER_DATA_NOT_FOUND', '杆塔不存在'), 404);
  const expectedVersion = intValue(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER);
  if (expectedVersion === null) return c.json(apiError('INVALID_VERSION', 'expectedVersion 必须为正整数'), 422);
  if (Number(before.version) !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '数据已变化，请刷新后重试'), 409);
  const towerNo = normalizeTowerNo(cleanText(body.towerNo, 80));
  if (!towerNo) return c.json(apiError('INVALID_TOWER_NUMBER', '杆塔新编号格式无法识别'), 422);
  if (towerNo === before.tower_no) return c.json(apiError('RENAME_NO_CHANGE', '杆塔新编号与当前编号相同'), 422);
  const reason = body.reason === undefined || body.reason === null ? null : cleanText(body.reason, 500) || null;
  const parent = await repository.findTowerParent(String(before.line_id));
  if (!parent) return c.json(apiError('LINE_NOT_FOUND', gridConstraintMessages.LINE_NOT_FOUND!), 422);
  const physical = await repository.findPhysicalTower(String(before.physical_tower_id));
  const data: LineTowerPositionSummary = {
    id,
    lineId: String(before.line_id),
    lineName: parent.lineName,
    physicalTowerId: String(before.physical_tower_id),
    physicalAssetCode: physical?.asset_code === null || physical?.asset_code === undefined ? null : String(physical.asset_code),
    towerNo,
    sortRank: Number(before.sort_rank),
    positionLabel: before.position_label === null ? null : String(before.position_label),
    towerTypeId: physical?.tower_type_id === null || physical?.tower_type_id === undefined ? null : String(physical.tower_type_id),
    towerTypeLabel: null,
    maintenanceTeamId: physical?.maintenance_team_id === null || physical?.maintenance_team_id === undefined ? null : String(physical.maintenance_team_id),
    maintenanceTeamName: null,
    enabled: Number(before.enabled) === 1,
    version: expectedVersion + 1,
  };
  const response = { ok: true as const, data }, now = new Date().toISOString();
  try {
    await repository.commitTowerRename({
      id, expectedVersion, towerNo, historyId: crypto.randomUUID(), reason,
      mutation: { key: mutation.key, actorId: c.get('currentUser').id, operation: mutation.operation, hash: mutation.hash, responseJson: JSON.stringify(response), statusCode: 200, now, auditId: crypto.randomUUID() },
      audit: { action: 'master.towers.rename', objectType: 'line_tower_positions', before, after: data },
    });
  } catch (cause) {
    const raced = await replay(c, mutation); if (raced) return raced;
    if (String(cause).includes('idempotency_records.request_hash')) return c.json(apiError('VERSION_CONFLICT', '数据已变化，请刷新后重试'), 409);
    throw cause;
  }
  return c.json(response, 200);
});

transmissionGridOperationsApp.post('/master/lines/:lineId/towers/:towerId/move', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const mutation = await beginMutation(c, body); if (mutation instanceof Response) return mutation;
  const lineId = c.req.param('lineId'), towerId = c.req.param('towerId');
  const expectedTowerOrderVersion = intValue(body.expectedTowerOrderVersion, 1, Number.MAX_SAFE_INTEGER);
  if (expectedTowerOrderVersion === null) return c.json(apiError('INVALID_ORDER_VERSION', 'expectedTowerOrderVersion 必须为正整数'), 422);
  const beforeTowerId = cleanText(body.beforeTowerId, 120) || null;
  const afterTowerId = cleanText(body.afterTowerId, 120) || null;
  if ((beforeTowerId ? 1 : 0) + (afterTowerId ? 1 : 0) !== 1) return c.json(apiError('INVALID_MOVE_TARGET', '请选择放在某一杆塔之前或之后'), 422);
  const targetTowerId = beforeTowerId ?? afterTowerId!;
  if (targetTowerId === towerId) return c.json(apiError('INVALID_MOVE_TARGET', '目标杆塔不能是自身'), 422);

  const repository = masterDataWriteRepository(c);
  const line = await repository.findRecord('line', lineId);
  if (!line) return c.json(apiError('MASTER_DATA_NOT_FOUND', '线路不存在'), 404);
  if (Number(line.tower_order_version) !== expectedTowerOrderVersion) return c.json(apiError('ORDER_VERSION_CONFLICT', '杆塔顺序已变化，请刷新后重试'), 409);
  const order = await repository.listTowerOrder(lineId);
  const moving = order.find((item) => item.id === towerId), target = order.find((item) => item.id === targetTowerId);
  if (!moving || !target) return c.json(apiError('INVALID_TOWER_RELATION', '移动杆塔和目标杆塔必须属于当前线路'), 422);

  const originalIds = order.map((item) => item.id);
  const withoutMoving = order.filter((item) => item.id !== towerId);
  const targetIndex = withoutMoving.findIndex((item) => item.id === targetTowerId);
  const insertIndex = beforeTowerId ? targetIndex : targetIndex + 1;
  const nextOrder = [...withoutMoving]; nextOrder.splice(insertIndex, 0, moving);
  if (nextOrder.every((item, index) => item.id === originalIds[index])) return c.json(apiError('ORDER_NO_CHANGE', '杆塔已经位于指定位置'), 422);

  const left = withoutMoving[insertIndex - 1] ?? null;
  const right = withoutMoving[insertIndex] ?? null;
  const rebalance = right
    ? right.sortRank - (left?.sortRank ?? 0) <= 1
    : (left?.sortRank ?? 0) > Number.MAX_SAFE_INTEGER - 1000;
  const response = { ok: true as const, data: { towerId, lineId, towerOrderVersion: expectedTowerOrderVersion + 1 } };
  const now = new Date().toISOString();
  try {
    await repository.commitTowerMove({
      lineId, towerId, targetTowerId, placement: beforeTowerId ? 'before' : 'after', expectedTowerOrderVersion, rebalance,
      mutation: { key: mutation.key, actorId: c.get('currentUser').id, operation: mutation.operation, hash: mutation.hash, responseJson: JSON.stringify(response), statusCode: 200, now, auditId: crypto.randomUUID() },
      audit: { action: 'master.towers.move', objectType: 'line_tower_positions', before: { towerId, order: originalIds }, after: { towerId, order: nextOrder.map((item) => item.id) } },
    });
  } catch (cause) {
    const raced = await replay(c, mutation); if (raced) return raced;
    const error = String(cause);
    if (error.includes('idempotency_records.request_hash') || error.includes('UNIQUE constraint')) return c.json(apiError('ORDER_VERSION_CONFLICT', '杆塔顺序已变化，请刷新后重试'), 409);
    throw cause;
  }
  return c.json(response, 200);
});

transmissionGridOperationsApp.post('/master/lines/:id/towers/import-chunk', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const mutation = await beginMutation(c, body); if (mutation instanceof Response) return mutation;
  if (!body || !Array.isArray(body.items) || !body.items.length || body.items.length > 20) {
    return c.json(apiError('INVALID_TOWER_IMPORT_CHUNK', '内部杆塔导入分片无效'), 422);
  }
  const expectedTowerOrderVersion = intValue(body.expectedTowerOrderVersion, 1, Number.MAX_SAFE_INTEGER);
  if (expectedTowerOrderVersion === null) return c.json(apiError('INVALID_ORDER_VERSION', '杆塔顺序版本无效'), 422);

  const lineId = c.req.param('id'), repository = masterDataWriteRepository(c);
  const parent = await repository.findTowerParent(lineId);
  if (!parent || !parent.enabled || !parent.voltageEnabled) return c.json(apiError('LINE_NOT_FOUND', gridConstraintMessages.LINE_NOT_FOUND!), 422);
  if (parent.towerOrderVersion !== expectedTowerOrderVersion) return c.json(apiError('ORDER_VERSION_CONFLICT', '杆塔顺序已变化，请刷新后重试'), 409);

  const updateIds = body.items
    .filter((item) => item && typeof item === 'object' && (item as Record<string, unknown>).action === 'update')
    .map((item) => cleanText((item as Record<string, unknown>).id, 120))
    .filter(Boolean);
  const existingUpdates = await repository.findTowerRecords(updateIds);
  const updateById = new Map(existingUpdates.map((row) => [String(row.id), row]));
  const currentOrder = await repository.listTowerOrder(lineId);
  const currentRank = new Map(currentOrder.map((item) => [item.id, item.sortRank]));
  const rebalancedRank = new Map(currentOrder.map((item, index) => [item.id, (index + 1) * 1000]));

  const parsed: Array<{
    action: 'create' | 'update'; id: string; expectedVersion: number | null;
    towerNo: string; positionLabel: string | null; enabled: boolean; sourceIndex: number;
    physicalTowerId: string; createPhysicalTower: CommitSingleMasterDataInput['createPhysicalTower'];
    before: Record<string, string | number | null> | null;
  }> = [];
  for (const [sourceIndex, raw] of body.items.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json(apiError('INVALID_TOWER_IMPORT_CHUNK', '内部杆塔导入行无效'), 422);
    const item = raw as Record<string, unknown>;
    const action = item.action === 'create' || item.action === 'update' ? item.action : null;
    const towerNo = normalizeTowerNo(cleanText(item.towerNo, 80));
    const positionLabel = item.positionLabel === null || item.positionLabel === undefined ? null : cleanText(item.positionLabel, 80) || null;
    const enabled = boolValue(item.enabled);
    if (!action || !towerNo || enabled === null || item.sortRank !== undefined) return c.json(apiError('INVALID_TOWER_IMPORT_CHUNK', '内部杆塔导入行无效'), 422);
    if (action === 'create') {
      let physicalTowerId = cleanText(item.physicalTowerId, 120);
      let createPhysicalTower: CommitSingleMasterDataInput['createPhysicalTower'];
      if (physicalTowerId) {
        const physical = await repository.findPhysicalTower(physicalTowerId);
        if (!physical || Number(physical.enabled) !== 1) return c.json(apiError('PHYSICAL_TOWER_NOT_FOUND', '导入行关联的物理杆塔不存在或已停用'), 422);
      } else {
        physicalTowerId = crypto.randomUUID();
        createPhysicalTower = {
          id: physicalTowerId,
          assetCode: cleanText(item.assetCode, 120) || null,
          towerTypeId: cleanText(item.towerTypeId, 120) || null,
          maintenanceTeamId: cleanText(item.maintenanceTeamId, 120) || null,
          enabled: true,
        };
      }
      parsed.push({ action, id: crypto.randomUUID(), expectedVersion: null, towerNo, positionLabel, enabled, sourceIndex, physicalTowerId, createPhysicalTower, before: null });
      continue;
    }
    const id = cleanText(item.id, 120), expectedVersion = intValue(item.expectedVersion, 1, Number.MAX_SAFE_INTEGER);
    const before = id ? updateById.get(id) ?? null : null;
    if (!id || expectedVersion === null || !before || before.line_id !== lineId) return c.json(apiError('INVALID_TOWER_RELATION', '导入更新对象不属于当前线路'), 422);
    if (Number(before.version) !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '杆塔数据已变化，请刷新后重新预览'), 409);
    if (String(before.tower_no) !== towerNo) return c.json(apiError('RENAME_REQUIRED', '导入不能修改杆塔编号，请使用“杆塔更名”操作'), 422);
    parsed.push({
      action,
      id,
      expectedVersion,
      towerNo,
      positionLabel,
      enabled,
      sourceIndex,
      physicalTowerId: String(before.physical_tower_id),
      createPhysicalTower: undefined,
      before,
    });
  }

  const created = parsed.filter((item) => item.action === 'create');
  const ranks = importedTowerRanks(currentOrder, created.map((item) => ({ id: item.id, towerNo: item.towerNo, sourceIndex: item.sourceIndex })));
  const changesTowerOrder = created.length > 0;
  const summaries: LineTowerPositionSummary[] = parsed.map((item) => ({
    id: item.id,
    lineId,
    lineName: parent.lineName,
    physicalTowerId: item.physicalTowerId,
    physicalAssetCode: item.createPhysicalTower?.assetCode ?? null,
    towerNo: item.towerNo,
    sortRank: item.action === 'create'
      ? ranks.get(item.id)!
      : (changesTowerOrder ? rebalancedRank.get(item.id)! : currentRank.get(item.id)!),
    positionLabel: item.positionLabel,
    towerTypeId: item.createPhysicalTower?.towerTypeId ?? null,
    towerTypeLabel: null,
    maintenanceTeamId: item.createPhysicalTower?.maintenanceTeamId ?? null,
    maintenanceTeamName: null,
    enabled: item.enabled,
    version: item.action === 'create' ? 1 : Number(item.before!.version) + 1,
  }));
  const response = {
    ok: true as const,
    data: {
      created: created.length,
      updated: parsed.length - created.length,
      towerOrderVersion: expectedTowerOrderVersion + (changesTowerOrder ? 1 : 0),
      items: summaries,
    },
  };
  const now = new Date().toISOString();
  try {
    await repository.commitTowerImportChunk({
      lineId,
      expectedTowerOrderVersion,
      changesTowerOrder,
      rebalanceTowerOrder: changesTowerOrder,
      items: parsed.map((item, index) => ({
        action: item.action,
        id: item.id,
        expectedVersion: item.expectedVersion,
        ...(item.createPhysicalTower ? { createPhysicalTower: item.createPhysicalTower } : {}),
        values: {
          lineId,
          physicalTowerId: item.physicalTowerId,
          towerNo: item.towerNo,
          sortRank: summaries[index]!.sortRank,
          positionLabel: item.positionLabel,
          enabled: item.enabled,
        },
      })),
      mutation: {
        key: mutation.key,
        actorId: c.get('currentUser').id,
        operation: mutation.operation,
        hash: mutation.hash,
        responseJson: JSON.stringify(response),
        statusCode: 201,
        now,
        auditId: crypto.randomUUID(),
      },
      audit: {
        action: 'master.towers.import-chunk',
        objectType: 'transmission_line',
        before: parsed.filter((item) => item.before).map((item) => item.before),
        after: summaries,
      },
    });
  } catch (cause) {
    const raced = await replay(c, mutation); if (raced) return raced;
    const error = String(cause);
    for (const [code, message] of Object.entries(gridConstraintMessages)) if (error.includes(code)) return c.json(apiError(code, message), 422);
    if (error.includes('idempotency_records.request_hash') || error.includes('UNIQUE constraint')) return c.json(apiError('ORDER_VERSION_CONFLICT', '杆塔顺序或数据已变化，请重新预览后重试'), 409);
    throw cause;
  }
  return c.json(response, 201);
});

transmissionGridOperationsApp.post('/master/lines/:id/towers/reorder', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const mutation = await beginMutation(c, body); if (mutation instanceof Response) return mutation;
  const expectedTowerOrderVersion = intValue(body.expectedTowerOrderVersion, 1, Number.MAX_SAFE_INTEGER);
  if (expectedTowerOrderVersion === null || !Array.isArray(body.towerIds) || !body.towerIds.length || body.towerIds.length > 50000) {
    return c.json(apiError('INVALID_TOWER_ORDER', '完整杆塔顺序清单无效'), 422);
  }
  const towerIds = body.towerIds.map((value) => cleanText(value, 120));
  if (towerIds.some((id) => !id) || new Set(towerIds).size !== towerIds.length) return c.json(apiError('INVALID_TOWER_ORDER', '完整杆塔顺序清单存在空值或重复对象'), 422);

  const lineId = c.req.param('id'), repository = masterDataWriteRepository(c);
  const parent = await repository.findTowerParent(lineId);
  if (!parent) return c.json(apiError('MASTER_DATA_NOT_FOUND', '线路不存在'), 404);
  if (parent.towerOrderVersion !== expectedTowerOrderVersion) return c.json(apiError('ORDER_VERSION_CONFLICT', '杆塔顺序已变化，请刷新后重试'), 409);
  const current = await repository.listTowerOrder(lineId);
  const currentIds = current.map((item) => item.id);
  const currentSet = new Set(currentIds);
  if (currentIds.length !== towerIds.length || towerIds.some((id) => !currentSet.has(id))) {
    return c.json(apiError('INCOMPLETE_TOWER_ORDER', '完整清单必须且只能包含当前线路的全部杆塔对象'), 422);
  }
  if (towerIds.every((id, index) => id === currentIds[index])) {
    return c.json({ ok: true as const, data: { changed: false, lineId, towerIds, towerOrderVersion: expectedTowerOrderVersion } }, 200);
  }

  const response = { ok: true as const, data: { changed: true, lineId, towerIds, towerOrderVersion: expectedTowerOrderVersion + 1 } };
  const now = new Date().toISOString();
  try {
    await repository.commitTowerReorder({
      lineId,
      expectedTowerOrderVersion,
      towerIds,
      mutation: {
        key: mutation.key,
        actorId: c.get('currentUser').id,
        operation: mutation.operation,
        hash: mutation.hash,
        responseJson: JSON.stringify(response),
        statusCode: 200,
        now,
        auditId: crypto.randomUUID(),
      },
      audit: {
        action: 'master.towers.reorder',
        objectType: 'transmission_line',
        before: { towerIds: currentIds },
        after: { towerIds },
      },
    });
  } catch (cause) {
    const raced = await replay(c, mutation); if (raced) return raced;
    const error = String(cause);
    if (error.includes('idempotency_records.request_hash') || error.includes('UNIQUE constraint')) return c.json(apiError('ORDER_VERSION_CONFLICT', '杆塔顺序已变化，请刷新后重试'), 409);
    throw cause;
  }
  return c.json(response, 200);
});
