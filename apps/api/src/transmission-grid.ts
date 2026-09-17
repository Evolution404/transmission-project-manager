import { Hono, type Context } from 'hono';
import type {
  LineTowerPositionSummary,
  TransmissionLineSummary,
  VoltageLevelSummary,
} from '@tpm/shared';
import { normalizeTowerNo } from '@tpm/shared';
import { requireRoles, type AppEnv } from './auth.ts';
import { inferNewTowerOrder } from './domain/tower-ordering.ts';
import { decodeJsonCursor, encodeJsonCursor } from './http/cursor.ts';
import { beginIdempotentMutation as beginMutation, replayIdempotentMutation as replay, type IdempotentMutation as Mutation } from './http/idempotent-mutation.ts';
import { apiError, boolValue, cleanText, intValue } from './http/request-values.ts';
import { masterDataRepository, masterDataWriteRepository } from './master-data-context.ts';
import type {
  CommitSingleMasterDataInput,
  MasterDataWriteKind,
} from './ports/master-data-write-repository';
import { gridConstraintMessages } from './transmission-grid-errors.ts';

export const transmissionGridApp = new Hono<AppEnv>();

transmissionGridApp.get('/master/voltage-levels', async (c) => {
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listVoltageLevels() } });
});

function listPage(c: Context<AppEnv>): { limit: number; cursor: [string, string] | null } | Response {
  const limit = Number(c.req.query('limit') ?? '100');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.json(apiError('INVALID_PAGE_LIMIT', 'limit 必须在 1–100 之间'), 400);
  const cursorParam = c.req.query('cursor');
  if (!cursorParam) return { limit, cursor: null };
  const cursor = decodeJsonCursor(cursorParam);
  if (!Array.isArray(cursor) || cursor.length !== 2 || cursor.some((v) => typeof v !== 'string')) {
    return c.json(apiError('INVALID_CURSOR', '分页游标无效'), 400);
  }
  return { limit, cursor: [cursor[0], cursor[1]] };
}

function pageCursor(first: string, id: string) {
  return encodeJsonCursor([first, id]);
}

transmissionGridApp.get('/master/lines', async (c) => {
  const page = listPage(c); if (page instanceof Response) return page;
  const voltageLevelId = cleanText(c.req.query('voltageLevelId'), 120) || null;
  const query = cleanText(c.req.query('query'), 200) || null;
  const rawEnabled = c.req.query('enabled');
  const enabled = rawEnabled === undefined ? null : rawEnabled === 'true' ? true : rawEnabled === 'false' ? false : null;
  if (rawEnabled !== undefined && enabled === null) return c.json(apiError('INVALID_ENABLED_FILTER', 'enabled 必须是 true 或 false'), 400);
  const rows = await masterDataRepository(c).listLines({
    voltageLevelId,
    enabled,
    query,
    cursor: page.cursor ? { lineName: page.cursor[0], id: page.cursor[1] } : null,
    limit: page.limit,
  });
  const selected = rows.slice(0, page.limit), last = selected.at(-1);
  return c.json({ ok: true as const, data: { items: selected, nextCursor: rows.length > page.limit && last ? pageCursor(last.lineName, last.id) : null } });
});

transmissionGridApp.get('/master/towers', async (c) => {
  const page = listPage(c); if (page instanceof Response) return page;
  const lineId = cleanText(c.req.query('lineId'), 120) || null;
  const rawQuery = cleanText(c.req.query('query'), 80) || null;
  const query = rawQuery ? normalizeTowerNo(rawQuery) : null;
  if (rawQuery && !query) return c.json(apiError('INVALID_TOWER_NUMBER', '杆塔编号格式无法识别'), 422);
  if (page.cursor && !Number.isSafeInteger(Number(page.cursor[0]))) return c.json(apiError('INVALID_CURSOR', '分页游标无效'), 400);
  const rows = await masterDataRepository(c).listLineTowerPositions({
    lineId,
    query,
    cursor: page.cursor ? { sortRank: Number(page.cursor[0]), id: page.cursor[1] } : null,
    limit: page.limit,
  });
  const selected = rows.slice(0, page.limit), last = selected.at(-1);
  return c.json({ ok: true as const, data: { items: selected, nextCursor: rows.length > page.limit && last ? pageCursor(String(last.sortRank), last.id) : null } });
});

type MasterKind = 'voltage-levels' | 'lines' | 'towers';
type MasterRecord = Record<string, string | number | null>;

const masterTables: Record<MasterKind, string> = {
  'voltage-levels': 'voltage_levels',
  lines: 'transmission_lines',
  towers: 'line_tower_positions',
};

const masterWriteKinds: Record<MasterKind, MasterDataWriteKind> = {
  'voltage-levels': 'voltage-level',
  lines: 'line',
  towers: 'tower-position',
};

async function prepareSingleMaster(c: Context<AppEnv>, kind: MasterKind, body: Record<string, unknown>, id: string, before: MasterRecord | null) {
  const repository = masterDataWriteRepository(c);
  const enabled = boolValue(body.enabled);
  if (enabled === null) return c.json(apiError('INVALID_MASTER_DATA', '启用状态必须为布尔值'), 422);
  const version = before ? Number(before.version) + 1 : 1;

  if (kind === 'voltage-levels') {
    const displayName = cleanText(body.displayName, 40), code = cleanText(body.code, 40).toUpperCase();
    const systemType: 'AC' | 'DC' | null = body.systemType === 'AC' || body.systemType === 'DC' ? body.systemType : null;
    const nominalKv = intValue(body.nominalKv, 1, 2000), sortOrder = intValue(body.sortOrder ?? 0, 0, 100000);
    if (!displayName || !code || !systemType || nominalKv === null || sortOrder === null) return c.json(apiError('INVALID_VOLTAGE_LEVEL', '电压等级参数不完整'), 422);
    const data: VoltageLevelSummary = { id, code, displayName, systemType, nominalKv, sortOrder, enabled, version };
    return {
      values: { code, displayName, systemType, nominalKv, sortOrder, enabled },
      data,
      requireEnabledParent: false,
      audit: { action: `master.${kind}.${before ? 'update' : 'create'}`, objectType: masterTables[kind], before, after: data },
    };
  }

  if (kind === 'lines') {
    const voltageLevelId = cleanText(body.voltageLevelId, 120), lineName = cleanText(body.lineName, 200), lineCode = cleanText(body.lineCode, 80) || null;
    if (!voltageLevelId || !lineName) return c.json(apiError('INVALID_LINE', '请选择电压等级并填写线路名称'), 422);
    const parent = await repository.findVoltageParent(voltageLevelId);
    const requireEnabledParent = !before || before.voltage_level_id !== voltageLevelId || enabled;
    if (!parent || (requireEnabledParent && !parent.enabled)) return c.json(apiError('VOLTAGE_LEVEL_NOT_FOUND', gridConstraintMessages.VOLTAGE_LEVEL_NOT_FOUND!), 422);
    const towerCount = before ? await repository.countLineTowers(id) : 0;
    const data: TransmissionLineSummary = {
      id,
      voltageLevelId,
      voltageLevelName: parent.displayName,
      lineName,
      lineCode,
      towerCount,
      enabled,
      version,
      towerOrderVersion: before ? Number(before.tower_order_version) : 1,
    };
    return {
      values: { voltageLevelId, lineName, lineCode, enabled },
      data,
      requireEnabledParent,
      audit: { action: `master.${kind}.${before ? 'update' : 'create'}`, objectType: masterTables[kind], before, after: data },
    };
  }

  const lineId = cleanText(body.lineId, 120), towerNo = normalizeTowerNo(cleanText(body.towerNo, 80)), sortRank = intValue(body.sortRank, 1, Number.MAX_SAFE_INTEGER), positionLabel = cleanText(body.positionLabel, 80) || null;
  if (!lineId || !towerNo || sortRank === null) return c.json(apiError('INVALID_TOWER', '线路、规范杆塔号和有效顺序不能为空'), 422);
  const parent = await repository.findTowerParent(lineId);
  const requireEnabledParent = !before || before.line_id !== lineId || enabled;
  if (!parent || (requireEnabledParent && (!parent.enabled || !parent.voltageEnabled))) return c.json(apiError('LINE_NOT_FOUND', gridConstraintMessages.LINE_NOT_FOUND!), 422);
  let physicalTowerId = before?.physical_tower_id ? String(before.physical_tower_id) : cleanText(body.physicalTowerId, 120);
  let createPhysicalTower: CommitSingleMasterDataInput['createPhysicalTower'];
  if (!physicalTowerId) {
    physicalTowerId = crypto.randomUUID();
    createPhysicalTower = {
      id: physicalTowerId,
      assetCode: cleanText(body.assetCode, 120) || null,
      towerTypeId: cleanText(body.towerTypeId, 120) || null,
      maintenanceTeamId: cleanText(body.maintenanceTeamId, 120) || null,
      enabled: true,
    };
  } else {
    const physical = await repository.findPhysicalTower(physicalTowerId);
    if (!physical || Number(physical.enabled) !== 1) return c.json(apiError('PHYSICAL_TOWER_NOT_FOUND', '所选物理杆塔不存在或已停用'), 422);
  }
  const physicalRecord = createPhysicalTower ? null : await repository.findPhysicalTower(physicalTowerId);
  const physicalAssetCode = createPhysicalTower
    ? createPhysicalTower.assetCode
    : physicalRecord?.asset_code === null || physicalRecord?.asset_code === undefined ? null : String(physicalRecord.asset_code);
  const physicalTowerTypeId = createPhysicalTower
    ? createPhysicalTower.towerTypeId
    : physicalRecord?.tower_type_id === null || physicalRecord?.tower_type_id === undefined ? null : String(physicalRecord.tower_type_id);
  const physicalMaintenanceTeamId = createPhysicalTower
    ? createPhysicalTower.maintenanceTeamId
    : physicalRecord?.maintenance_team_id === null || physicalRecord?.maintenance_team_id === undefined ? null : String(physicalRecord.maintenance_team_id);
  const data: LineTowerPositionSummary = {
    id,
    lineId,
    lineName: parent.lineName,
    physicalTowerId,
    physicalAssetCode,
    towerNo,
    sortRank,
    positionLabel,
    towerTypeId: physicalTowerTypeId,
    towerTypeLabel: null,
    maintenanceTeamId: physicalMaintenanceTeamId,
    maintenanceTeamName: null,
    enabled,
    version,
  };
  return {
    values: { lineId, physicalTowerId, towerNo, sortRank, positionLabel, enabled },
    createPhysicalTower,
    data,
    requireEnabledParent,
    audit: { action: `master.${kind}.${before ? 'update' : 'create'}`, objectType: masterTables[kind], before, after: data },
  };
}

async function commitSingleMaster(c: Context<AppEnv>, mutation: Mutation, input: Omit<CommitSingleMasterDataInput, 'mutation'>, data: unknown, status: 200 | 201) {
  const response = { ok: true as const, data };
  const now = new Date().toISOString();
  try {
    await masterDataWriteRepository(c).commitSingle({
      ...input,
      mutation: {
        key: mutation.key,
        actorId: c.get('currentUser').id,
        operation: mutation.operation,
        hash: mutation.hash,
        responseJson: JSON.stringify(response),
        statusCode: status,
        now,
        auditId: crypto.randomUUID(),
      },
    });
  } catch (cause) {
    const raced = await replay(c, mutation); if (raced) return raced;
    const error = String(cause);
    for (const [code, message] of Object.entries(gridConstraintMessages)) if (error.includes(code)) return c.json(apiError(code, message), 422);
    if (error.includes('idempotency_records.request_hash')) return c.json(apiError('VERSION_CONFLICT', '数据已变化，请刷新后重试'), 409);
    if (error.includes('UNIQUE constraint')) return c.json(apiError('MASTER_DATA_CONFLICT', '名称、编码、杆塔号或线路顺序重复，请检查'), 409);
    if (error.includes('FOREIGN KEY constraint')) return c.json(apiError('MASTER_DATA_IN_USE', gridConstraintMessages.MASTER_DATA_IN_USE!), 422);
    throw cause;
  }
  return c.json(response, status);
}

for (const kind of Object.keys(masterTables) as MasterKind[]) {
  for (const method of ['post', 'patch', 'delete'] as const) {
    transmissionGridApp[method](`/master/${kind}${method === 'post' ? '' : '/:id'}`, requireRoles('admin'), async (c) => {
      let body: Record<string, unknown>;
      try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
      const mutation = await beginMutation(c, body); if (mutation instanceof Response) return mutation;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json(apiError('INVALID_MASTER_DATA', '请求体必须为对象'), 422);
      const repository = masterDataWriteRepository(c);
      const id = method === 'post' ? crypto.randomUUID() : c.req.param('id')!;
      const before = method === 'post' ? null : await repository.findRecord(masterWriteKinds[kind], id);
      if (method !== 'post' && !before) return c.json(apiError('MASTER_DATA_NOT_FOUND', '台账对象不存在'), 404);
      let towerOrderContext: { lineId: string; version: number; rebalance: boolean } | null = null;
      if (kind === 'towers' && method === 'post') {
        const lineId = cleanText(body.lineId, 120);
        const parent = lineId ? await repository.findTowerParent(lineId) : null;
        if (!parent) return c.json(apiError('LINE_NOT_FOUND', gridConstraintMessages.LINE_NOT_FOUND!), 422);
        const towerNo = normalizeTowerNo(cleanText(body.towerNo, 80));
        if (!towerNo) return c.json(apiError('INVALID_TOWER_NUMBER', '杆塔编号格式无法识别'), 422);
        const order = await repository.listTowerOrder(lineId);
        const inferred = inferNewTowerOrder(order, towerNo);
        towerOrderContext = { lineId, version: parent.towerOrderVersion, rebalance: inferred.rebalance };
        body = { ...body, towerNo, sortRank: inferred.sortRank };
      } else if (kind === 'towers' && method === 'delete' && before) {
        const lineId = String(before.line_id);
        const parent = await repository.findTowerParent(lineId);
        if (!parent) return c.json(apiError('LINE_NOT_FOUND', gridConstraintMessages.LINE_NOT_FOUND!), 422);
        towerOrderContext = { lineId, version: parent.towerOrderVersion, rebalance: false };
      }
      const version = intValue(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER);
      if (method !== 'post' && version === null) return c.json(apiError('INVALID_VERSION', 'expectedVersion 必须为正整数'), 422);
      if (before && before.version !== version) return c.json(apiError('VERSION_CONFLICT', '数据已变化，请刷新后重试'), 409);
      if (method === 'delete') {
        const data = { id, deleted: true };
        return commitSingleMaster(c, mutation, {
          kind: masterWriteKinds[kind],
          action: 'delete',
          id,
          expectedVersion: version,
          ...(towerOrderContext ? {
            parentLineId: towerOrderContext.lineId,
            expectedTowerOrderVersion: towerOrderContext.version,
            changesTowerOrder: true,
            rebalanceTowerOrder: towerOrderContext.rebalance,
          } : {}),
          audit: { action: `master.${kind}.delete`, objectType: masterTables[kind], before, after: null },
        }, data, 200);
      }
      if (method === 'patch' && before && kind === 'lines' && cleanText(body.lineName, 200) !== before.line_name) {
        return c.json(apiError('RENAME_REQUIRED', '线路名称变更必须使用“线路更名”操作，以保留历史名称'), 422);
      }
      if (method === 'patch' && before && kind === 'towers' && normalizeTowerNo(cleanText(body.towerNo, 80)) !== before.tower_no) {
        return c.json(apiError('RENAME_REQUIRED', '杆塔编号变更必须使用“杆塔更名”操作，以保留历史编号'), 422);
      }
      if (method === 'patch' && before && kind === 'towers' && cleanText(body.lineId, 120) !== before.line_id) {
        return c.json(apiError('TOWER_LINE_CHANGE_UNSUPPORTED', '杆塔不能通过普通编辑切换所属线路'), 422);
      }
      if (method === 'patch' && before && kind === 'towers' && cleanText(body.physicalTowerId, 120) && cleanText(body.physicalTowerId, 120) !== before.physical_tower_id) {
        return c.json(apiError('PHYSICAL_TOWER_REBIND_REQUIRED', '同塔关系变更必须使用专用“关联物理杆塔”操作'), 422);
      }
      if (method === 'patch' && before && kind === 'towers' && Number(body.sortRank) !== Number(before.sort_rank)) {
        return c.json(apiError('ORDER_MOVE_REQUIRED', '杆塔顺序变更必须使用“调整顺序”操作'), 422);
      }
      const prepared = await prepareSingleMaster(c, kind, body, id, before); if (prepared instanceof Response) return prepared;
      return commitSingleMaster(c, mutation, {
        kind: masterWriteKinds[kind],
        action: method === 'post' ? 'create' : 'update',
        id,
        values: prepared.values,
        ...(prepared.createPhysicalTower ? { createPhysicalTower: prepared.createPhysicalTower } : {}),
        expectedVersion: method === 'post' ? null : version,
        ...(towerOrderContext ? {
          parentLineId: towerOrderContext.lineId,
          expectedTowerOrderVersion: towerOrderContext.version,
          changesTowerOrder: true,
          rebalanceTowerOrder: towerOrderContext.rebalance,
        } : {}),
        requireEnabledParent: prepared.requireEnabledParent,
        audit: prepared.audit,
      }, prepared.data, method === 'post' ? 201 : 200);
    });
  }
}
