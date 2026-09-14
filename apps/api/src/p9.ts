import { Hono, type Context } from 'hono';
import type {
  ApiError,
  CreateStructuredDemandRequest,
  DemandDetail,
  DemandLocationType,
  DemandMaterialInput,
  TransmissionLineSummary,
  TransmissionTowerSummary,
  VoltageLevelSummary,
} from '@tpm/shared';
import { compareTowerNo, normalizeTowerNo } from '@tpm/shared';
import { requireRoles, type AppEnv } from './auth.ts';
import type { CommitSingleMasterDataInput, MasterDataWriteKind } from './ports/master-data-write-repository';
import { SqlDemandRepository } from './repositories/sql-demand-repository.ts';
import { SqlIdempotencyRepository } from './repositories/sql-idempotency-repository.ts';
import { SqlMasterDataRepository } from './repositories/sql-master-data-repository.ts';
import { SqlMasterDataWriteRepository } from './repositories/sql-master-data-write-repository.ts';
import { resolvePersistence as createCloudflarePersistence } from './runtime/persistence.ts';

export const p9App = new Hono<AppEnv>();

function apiError(code: string, message: string, details?: unknown): ApiError {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function cleanText(value: unknown, max = 200): string {
  return typeof value === 'string' ? (value.trim().length <= max ? value.trim() : '') : '';
}

function boolValue(value: unknown, fallback = true): boolean | null {
  if (value === undefined) return fallback;
  return typeof value === 'boolean' ? value : null;
}

function intValue(value: unknown, min: number, max: number): number | null {
  const parsed = typeof value === 'number' ? value : NaN;
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

async function hashValue(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseMaterials(value: unknown): DemandMaterialInput[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) return null;
  const result: DemandMaterialInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const raw = item as Record<string, unknown>;
    const rawModel = cleanText(raw.rawModel, 200);
    const materialId = raw.materialId === null || raw.materialId === undefined ? null : cleanText(raw.materialId, 120);
    const quantityScaled = Number(raw.quantityScaled);
    const unit = raw.unit === null || raw.unit === undefined ? null : cleanText(raw.unit, 40);
    if (!rawModel || !Number.isSafeInteger(quantityScaled) || quantityScaled <= 0 || (raw.materialId !== null && raw.materialId !== undefined && !materialId)) return null;
    result.push({ rawModel, materialId, quantityScaled, unit: unit || null });
  }
  return result;
}

function masterDataRepository(c: Context<AppEnv>) {
  const { database } = createCloudflarePersistence(c.env);
  return new SqlMasterDataRepository(database);
}

function masterDataWriteRepository(c: Context<AppEnv>) {
  const { database } = createCloudflarePersistence(c.env);
  return new SqlMasterDataWriteRepository(database);
}

function demandRepository(c: Context<AppEnv>) {
  const { database } = createCloudflarePersistence(c.env);
  return new SqlDemandRepository(database);
}

function idempotencyRepository(c: Context<AppEnv>) {
  const { database } = createCloudflarePersistence(c.env);
  return new SqlIdempotencyRepository(database);
}

p9App.get('/master/voltage-levels', async (c) => {
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listVoltageLevels() } });
});
function listPage(c: Context<AppEnv>): { limit: number; cursor: [string, string] | null } | Response {
  const limit = Number(c.req.query('limit') ?? '100');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.json(apiError('INVALID_PAGE_LIMIT', 'limit 必须在 1–100 之间'), 400);
  try {
    const cursor = c.req.query('cursor') ? JSON.parse(decodeURIComponent(atob(c.req.query('cursor')!))) : null;
    if (cursor !== null && (!Array.isArray(cursor) || cursor.length !== 2 || cursor.some((v) => typeof v !== 'string'))) throw new Error();
    return { limit, cursor };
  } catch { return c.json(apiError('INVALID_CURSOR', '分页游标无效'), 400); }
}
function pageCursor(first: string, id: string) { return btoa(encodeURIComponent(JSON.stringify([first, id]))); }

function inferNewTowerOrder(
  existing: readonly { id: string; towerNo: string; sortRank: number }[],
  towerNo: string,
): { sortRank: number; rebalance: boolean } {
  if (!existing.length) return { sortRank: 1000, rebalance: false };

  let insertIndex = existing.findIndex((item) => compareTowerNo(towerNo, item.towerNo) < 0);
  if (insertIndex < 0) insertIndex = existing.length;
  const left = insertIndex > 0 ? existing[insertIndex - 1]! : null;
  const right = insertIndex < existing.length ? existing[insertIndex]! : null;

  if (!left && right) {
    if (right.sortRank > 1) return { sortRank: Math.floor(right.sortRank / 2), rebalance: false };
    return { sortRank: 500, rebalance: true };
  }
  if (left && !right) {
    if (left.sortRank <= Number.MAX_SAFE_INTEGER - 1000) return { sortRank: left.sortRank + 1000, rebalance: false };
    return { sortRank: (existing.length + 1) * 1000, rebalance: true };
  }
  if (left && right) {
    const gap = right.sortRank - left.sortRank;
    if (gap > 1) return { sortRank: Math.floor((left.sortRank + right.sortRank) / 2), rebalance: false };
    return { sortRank: insertIndex * 1000 + 500, rebalance: true };
  }
  return { sortRank: 1000, rebalance: false };
}

function importedTowerRanks(
  existing: readonly { id: string; towerNo: string; sortRank: number }[],
  created: readonly { id: string; towerNo: string; sourceIndex: number }[],
): Map<string, number> {
  const byGap = new Map<number, Array<{ id: string; towerNo: string; sourceIndex: number }>>();
  for (const item of created) {
    let gap = existing.findIndex((current) => compareTowerNo(item.towerNo, current.towerNo) < 0);
    if (gap < 0) gap = existing.length;
    const group = byGap.get(gap) ?? [];
    group.push(item); byGap.set(gap, group);
  }
  const ranks = new Map<string, number>();
  for (const [gap, unsorted] of byGap) {
    const group = [...unsorted].sort((a, b) => compareTowerNo(a.towerNo, b.towerNo) || a.sourceIndex - b.sourceIndex);
    const leftRank = gap * 1000;
    if (gap === existing.length) {
      group.forEach((item, index) => ranks.set(item.id, leftRank + (index + 1) * 1000));
      continue;
    }
    const width = 1000;
    group.forEach((item, index) => ranks.set(item.id, leftRank + Math.floor(width * (index + 1) / (group.length + 1))));
  }
  return ranks;
}
p9App.get('/master/lines', async (c) => {
  const page = listPage(c); if (page instanceof Response) return page;
  const voltageLevelId = cleanText(c.req.query('voltageLevelId'), 120) || null;
  const query = cleanText(c.req.query('query'), 200) || null;
  const rows = await masterDataRepository(c).listLines({
    voltageLevelId,
    query,
    cursor: page.cursor ? { lineName: page.cursor[0], id: page.cursor[1] } : null,
    limit: page.limit,
  });
  const selected = rows.slice(0, page.limit), last = selected.at(-1);
  return c.json({ ok: true as const, data: { items: selected, nextCursor: rows.length > page.limit && last ? pageCursor(last.lineName,last.id) : null } });
});
p9App.get('/master/towers', async (c) => {
  const page = listPage(c); if (page instanceof Response) return page;
  const lineId = cleanText(c.req.query('lineId'), 120) || null;
  const rawQuery = cleanText(c.req.query('query'), 80) || null;
  const query = rawQuery ? normalizeTowerNo(rawQuery) : null;
  if (rawQuery && !query) return c.json(apiError('INVALID_TOWER_NUMBER', '杆塔编号格式无法识别'), 422);
  if (page.cursor && !Number.isSafeInteger(Number(page.cursor[0]))) return c.json(apiError('INVALID_CURSOR', '分页游标无效'), 400);
  const rows = await masterDataRepository(c).listTowers({
    lineId,
    query,
    cursor: page.cursor ? { sortRank: Number(page.cursor[0]), id: page.cursor[1] } : null,
    limit: page.limit,
  });
  const selected = rows.slice(0,page.limit), last = selected.at(-1);
  return c.json({ ok: true as const, data: { items: selected, nextCursor: rows.length > page.limit && last ? pageCursor(String(last.sortRank),last.id) : null } });
});

// The idempotency record is the first statement in the same atomic persistence batch.
// A stale version violates NOT NULL before any business write or audit is made.
type Mutation = { key: string; operation: string; hash: string };
async function beginMutation(c: Context<AppEnv>, body: unknown): Promise<Mutation | Response> {
  const key = c.req.header('Idempotency-Key')?.trim();
  if (!key || key.length > 200) return c.json(apiError('IDEMPOTENCY_KEY_REQUIRED', '变更请求必须提供有效的 Idempotency-Key'), 400);
  const mutation = { key, operation: `${c.req.method}:${c.req.path}`, hash: await hashValue(body) };
  return (await replay(c, mutation)) ?? mutation;
}
async function replay(c: Context<AppEnv>, mutation: Mutation) {
  const row = await idempotencyRepository(c).findByKey(mutation.key);
  if (!row) return null;
  if (row.actorMemberId !== c.get('currentUser').id || row.operation !== mutation.operation || row.requestHash !== mutation.hash) return c.json(apiError('IDEMPOTENCY_CONFLICT', '该 Idempotency-Key 已用于不同请求'), 409);
  return new Response(row.responseJson, { status: row.statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
const constraintMessages: Record<string, string> = {
  VOLTAGE_LEVEL_NOT_FOUND: '电压等级不存在或已停用，请先维护基础台账',
  LINE_NOT_FOUND: '线路或所属电压等级不存在或已停用，请先维护基础台账',
  LINE_LOCATION_IN_USE: '线路已被需求或项目引用，不能更换电压等级',
  TOWER_LOCATION_IN_USE: '线路已有需求区段，不能跨线路移动或删除受保护杆塔；可停用',
  MASTER_DATA_IN_USE: '对象已被业务引用或仍有下级台账，不能删除；请停用',
  VOLTAGE_LOCATION_IN_USE: '电压等级已被业务引用，不能改变制式或标称电压',
  INVALID_GRID_LOCATION: '需求位置关联已变化或停用，请刷新并先维护基础台账',
};
type MasterKind = 'voltage-levels' | 'lines' | 'towers';
const masterTables: Record<MasterKind, string> = { 'voltage-levels': 'voltage_levels', lines: 'transmission_lines', towers: 'transmission_towers' };
type MasterRecord = Record<string, string | number | null>;
const masterWriteKinds: Record<MasterKind, MasterDataWriteKind> = {
  'voltage-levels': 'voltage-level',
  lines: 'line',
  towers: 'tower',
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
    if (!parent || (requireEnabledParent && !parent.enabled)) return c.json(apiError('VOLTAGE_LEVEL_NOT_FOUND', constraintMessages.VOLTAGE_LEVEL_NOT_FOUND!), 422);
    const towerCount = before ? await repository.countLineTowers(id) : 0;
    const data: TransmissionLineSummary = { id, voltageLevelId, voltageLevelName: parent.displayName, lineName, lineCode, towerCount, enabled, version, towerOrderVersion: before ? Number(before.tower_order_version) : 1 };
    return {
      values: { voltageLevelId, lineName, lineCode, enabled },
      data,
      requireEnabledParent,
      audit: { action: `master.${kind}.${before ? 'update' : 'create'}`, objectType: masterTables[kind], before, after: data },
    };
  }
  const lineId = cleanText(body.lineId, 120), towerNo = normalizeTowerNo(cleanText(body.towerNo, 80)), sortRank = intValue(body.sortRank, 1, Number.MAX_SAFE_INTEGER), towerType = cleanText(body.towerType, 80) || null;
  if (!lineId || !towerNo || sortRank === null) return c.json(apiError('INVALID_TOWER', '线路、规范杆塔号和有效顺序不能为空'), 422);
  const parent = await repository.findTowerParent(lineId);
  const requireEnabledParent = !before || before.line_id !== lineId || enabled;
  if (!parent || (requireEnabledParent && (!parent.enabled || !parent.voltageEnabled))) return c.json(apiError('LINE_NOT_FOUND', constraintMessages.LINE_NOT_FOUND!), 422);
  const data: TransmissionTowerSummary = { id, lineId, lineName: parent.lineName, towerNo, sortRank, towerType, enabled, version };
  return {
    values: { lineId, towerNo, sortRank, towerType, enabled },
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
    for (const [code, message] of Object.entries(constraintMessages)) if (error.includes(code)) return c.json(apiError(code, message), 422);
    if (error.includes('idempotency_records.request_hash')) return c.json(apiError('VERSION_CONFLICT', '数据已变化，请刷新后重试'), 409);
    if (error.includes('UNIQUE constraint')) return c.json(apiError('MASTER_DATA_CONFLICT', '名称、编码、杆塔号或线路顺序重复，请检查'), 409);
    if (error.includes('FOREIGN KEY constraint')) return c.json(apiError('MASTER_DATA_IN_USE', constraintMessages.MASTER_DATA_IN_USE!), 422);
    throw cause;
  }
  return c.json(response, status);
}

for (const kind of Object.keys(masterTables) as MasterKind[]) {
  for (const method of ['post', 'patch', 'delete'] as const) {
    p9App[method](`/master/${kind}${method === 'post' ? '' : '/:id'}`, requireRoles('admin'), async (c) => {
      let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
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
        if (!parent) return c.json(apiError('LINE_NOT_FOUND', constraintMessages.LINE_NOT_FOUND!), 422);
        const towerNo = normalizeTowerNo(cleanText(body.towerNo, 80));
        if (!towerNo) return c.json(apiError('INVALID_TOWER_NUMBER', '杆塔编号格式无法识别'), 422);
        const order = await repository.listTowerOrder(lineId);
        const inferred = inferNewTowerOrder(order, towerNo);
        towerOrderContext = { lineId, version: parent.towerOrderVersion, rebalance: inferred.rebalance };
        body = { ...body, towerNo, sortRank: inferred.sortRank };
      } else if (kind === 'towers' && method === 'delete' && before) {
        const lineId = String(before.line_id);
        const parent = await repository.findTowerParent(lineId);
        if (!parent) return c.json(apiError('LINE_NOT_FOUND', constraintMessages.LINE_NOT_FOUND!), 422);
        towerOrderContext = { lineId, version: parent.towerOrderVersion, rebalance: false };
      }
      const version = intValue(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER);
      if (method !== 'post' && version === null) return c.json(apiError('INVALID_VERSION', 'expectedVersion 必须为正整数'), 422);
      if (before && before.version !== version) return c.json(apiError('VERSION_CONFLICT', '数据已变化，请刷新后重试'), 409);
      if (method === 'delete') {
        const data = { id, deleted: true };
        return commitSingleMaster(c, mutation, {
          kind: masterWriteKinds[kind], action: 'delete', id, expectedVersion: version,
          ...(towerOrderContext ? { parentLineId: towerOrderContext.lineId, expectedTowerOrderVersion: towerOrderContext.version, changesTowerOrder: true, rebalanceTowerOrder: towerOrderContext.rebalance } : {}),
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
      if (method === 'patch' && before && kind === 'towers' && Number(body.sortRank) !== Number(before.sort_rank)) {
        return c.json(apiError('ORDER_MOVE_REQUIRED', '杆塔顺序变更必须使用“调整顺序”操作'), 422);
      }
      const prepared = await prepareSingleMaster(c, kind, body, id, before); if (prepared instanceof Response) return prepared;
      return commitSingleMaster(c, mutation, {
        kind: masterWriteKinds[kind], action: method === 'post' ? 'create' : 'update', id,
        values: prepared.values, expectedVersion: method === 'post' ? null : version,
        ...(towerOrderContext ? { parentLineId: towerOrderContext.lineId, expectedTowerOrderVersion: towerOrderContext.version, changesTowerOrder: true, rebalanceTowerOrder: towerOrderContext.rebalance } : {}),
        requireEnabledParent: prepared.requireEnabledParent, audit: prepared.audit,
      }, prepared.data, method === 'post' ? 201 : 200);
    });
  }
}

p9App.get('/master/lines/:id/name-history', async (c) => {
  const id = c.req.param('id');
  const record = await masterDataWriteRepository(c).findRecord('line', id);
  if (!record) return c.json(apiError('MASTER_DATA_NOT_FOUND', '线路不存在'), 404);
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listLineNameHistory(id) } });
});

p9App.get('/master/towers/:id/number-history', async (c) => {
  const id = c.req.param('id');
  const record = await masterDataWriteRepository(c).findRecord('tower', id);
  if (!record) return c.json(apiError('MASTER_DATA_NOT_FOUND', '杆塔不存在'), 404);
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listTowerNoHistory(id) } });
});

p9App.post('/master/lines/:id/rename', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
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
  if (!parent) return c.json(apiError('VOLTAGE_LEVEL_NOT_FOUND', constraintMessages.VOLTAGE_LEVEL_NOT_FOUND!), 422);
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

p9App.post('/master/towers/:id/rename', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const mutation = await beginMutation(c, body); if (mutation instanceof Response) return mutation;
  const id = c.req.param('id'), repository = masterDataWriteRepository(c);
  const before = await repository.findRecord('tower', id);
  if (!before) return c.json(apiError('MASTER_DATA_NOT_FOUND', '杆塔不存在'), 404);
  const expectedVersion = intValue(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER);
  if (expectedVersion === null) return c.json(apiError('INVALID_VERSION', 'expectedVersion 必须为正整数'), 422);
  if (Number(before.version) !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '数据已变化，请刷新后重试'), 409);
  const towerNo = normalizeTowerNo(cleanText(body.towerNo, 80));
  if (!towerNo) return c.json(apiError('INVALID_TOWER_NUMBER', '杆塔新编号格式无法识别'), 422);
  if (towerNo === before.tower_no) return c.json(apiError('RENAME_NO_CHANGE', '杆塔新编号与当前编号相同'), 422);
  const reason = body.reason === undefined || body.reason === null ? null : cleanText(body.reason, 500) || null;
  const parent = await repository.findTowerParent(String(before.line_id));
  if (!parent) return c.json(apiError('LINE_NOT_FOUND', constraintMessages.LINE_NOT_FOUND!), 422);
  const data: TransmissionTowerSummary = {
    id,
    lineId: String(before.line_id),
    lineName: parent.lineName,
    towerNo,
    sortRank: Number(before.sort_rank),
    towerType: before.tower_type === null ? null : String(before.tower_type),
    enabled: Number(before.enabled) === 1,
    version: expectedVersion + 1,
  };
  const response = { ok: true as const, data }, now = new Date().toISOString();
  try {
    await repository.commitTowerRename({
      id, expectedVersion, towerNo, historyId: crypto.randomUUID(), reason,
      mutation: { key: mutation.key, actorId: c.get('currentUser').id, operation: mutation.operation, hash: mutation.hash, responseJson: JSON.stringify(response), statusCode: 200, now, auditId: crypto.randomUUID() },
      audit: { action: 'master.towers.rename', objectType: 'transmission_towers', before, after: data },
    });
  } catch (cause) {
    const raced = await replay(c, mutation); if (raced) return raced;
    if (String(cause).includes('idempotency_records.request_hash')) return c.json(apiError('VERSION_CONFLICT', '数据已变化，请刷新后重试'), 409);
    throw cause;
  }
  return c.json(response, 200);
});

p9App.post('/master/lines/:lineId/towers/:towerId/move', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
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
      audit: { action: 'master.towers.move', objectType: 'transmission_towers', before: { towerId, order: originalIds }, after: { towerId, order: nextOrder.map((item) => item.id) } },
    });
  } catch (cause) {
    const raced = await replay(c, mutation); if (raced) return raced;
    const error = String(cause);
    if (error.includes('idempotency_records.request_hash')) return c.json(apiError('ORDER_VERSION_CONFLICT', '杆塔顺序已变化，请刷新后重试'), 409);
    if (error.includes('UNIQUE constraint')) return c.json(apiError('ORDER_VERSION_CONFLICT', '杆塔顺序已变化，请刷新后重试'), 409);
    throw cause;
  }
  return c.json(response, 200);
});

p9App.post('/master/lines/:id/towers/import-chunk', requireRoles('admin'), async (c) => {
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
  if (!parent || !parent.enabled || !parent.voltageEnabled) return c.json(apiError('LINE_NOT_FOUND', constraintMessages.LINE_NOT_FOUND!), 422);
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
    towerNo: string; towerType: string | null; enabled: boolean; sourceIndex: number;
    before: Record<string, string | number | null> | null;
  }> = [];
  for (const [sourceIndex, raw] of body.items.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json(apiError('INVALID_TOWER_IMPORT_CHUNK', '内部杆塔导入行无效'), 422);
    const item = raw as Record<string, unknown>;
    const action = item.action === 'create' || item.action === 'update' ? item.action : null;
    const towerNo = normalizeTowerNo(cleanText(item.towerNo, 80));
    const towerType = item.towerType === null || item.towerType === undefined ? null : cleanText(item.towerType, 80) || null;
    const enabled = boolValue(item.enabled);
    if (!action || !towerNo || enabled === null || item.sortRank !== undefined) return c.json(apiError('INVALID_TOWER_IMPORT_CHUNK', '内部杆塔导入行无效'), 422);
    if (action === 'create') {
      parsed.push({ action, id: crypto.randomUUID(), expectedVersion: null, towerNo, towerType, enabled, sourceIndex, before: null });
      continue;
    }
    const id = cleanText(item.id, 120), expectedVersion = intValue(item.expectedVersion, 1, Number.MAX_SAFE_INTEGER);
    const before = id ? updateById.get(id) ?? null : null;
    if (!id || expectedVersion === null || !before || before.line_id !== lineId) return c.json(apiError('INVALID_TOWER_RELATION', '导入更新对象不属于当前线路'), 422);
    if (Number(before.version) !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '杆塔数据已变化，请刷新后重新预览'), 409);
    if (String(before.tower_no) !== towerNo) return c.json(apiError('RENAME_REQUIRED', '导入不能修改杆塔编号，请使用“杆塔更名”操作'), 422);
    parsed.push({ action, id, expectedVersion, towerNo, towerType, enabled, sourceIndex, before });
  }

  const created = parsed.filter((item) => item.action === 'create');
  const ranks = importedTowerRanks(currentOrder, created.map((item) => ({ id: item.id, towerNo: item.towerNo, sourceIndex: item.sourceIndex })));
  const changesTowerOrder = created.length > 0;
  const summaries: TransmissionTowerSummary[] = parsed.map((item) => ({
    id: item.id,
    lineId,
    lineName: parent.lineName,
    towerNo: item.towerNo,
    sortRank: item.action === 'create'
      ? ranks.get(item.id)!
      : (changesTowerOrder ? rebalancedRank.get(item.id)! : currentRank.get(item.id)!),
    towerType: item.towerType,
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
        values: {
          lineId,
          towerNo: item.towerNo,
          sortRank: summaries[index]!.sortRank,
          towerType: item.towerType,
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
    for (const [code, message] of Object.entries(constraintMessages)) if (error.includes(code)) return c.json(apiError(code, message), 422);
    if (error.includes('idempotency_records.request_hash') || error.includes('UNIQUE constraint')) return c.json(apiError('ORDER_VERSION_CONFLICT', '杆塔顺序或数据已变化，请重新预览后重试'), 409);
    throw cause;
  }
  return c.json(response, 201);
});

p9App.post('/master/lines/:id/towers/reorder', requireRoles('admin'), async (c) => {
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

p9App.post('/master/lines/:id/towers/batch', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const mutation = await beginMutation(c, body); if (mutation instanceof Response) return mutation;
  if (!body || !Array.isArray(body.items) || !body.items.length || body.items.length > 20) return c.json(apiError('INVALID_TOWER_BATCH', '每次批量维护 1–20 个杆塔'), 422);
  const repository = masterDataWriteRepository(c), lineId = c.req.param('id');
  const parent = await repository.findTowerParent(lineId);
  if (!parent || !parent.enabled || !parent.voltageEnabled) return c.json(apiError('LINE_NOT_FOUND', constraintMessages.LINE_NOT_FOUND!), 422);
  const ids = body.items.filter((item) => item && typeof item === 'object' && typeof item.id === 'string').map((item) => item.id as string);
  const existing = await repository.findTowerRecords(ids);
  const byId = new Map(existing.map((row) => [String(row.id), row]));
  const writeItems = [], items: TransmissionTowerSummary[] = [], beforeRows: MasterRecord[] = [], seen = new Set<string>();
  for (const raw of body.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json(apiError('INVALID_TOWER', '杆塔行格式无效'), 422);
    const item = raw as Record<string, unknown>;
    const id = item.id === undefined ? crypto.randomUUID() : cleanText(item.id, 120);
    if (!id || seen.has(id)) return c.json(apiError('INVALID_TOWER', '杆塔 ID 为空或重复'), 422); seen.add(id);
    const before = byId.get(id) ?? null;
    if (item.id !== undefined && (!before || before.line_id !== lineId)) return c.json(apiError('INVALID_TOWER_RELATION', '批量维护只能修改当前线路的杆塔'), 422);
    const version = before ? intValue(item.expectedVersion, 1, Number.MAX_SAFE_INTEGER) : null;
    if (before && (version === null || before.version !== version)) return c.json(apiError('VERSION_CONFLICT', '杆塔版本已变化，请刷新后重试'), 409);
    const towerNo = normalizeTowerNo(cleanText(item.towerNo, 80)), sortRank = intValue(item.sortRank, 1, Number.MAX_SAFE_INTEGER), towerType = cleanText(item.towerType, 80) || null, enabled = boolValue(item.enabled);
    if (!towerNo || sortRank === null || enabled === null) return c.json(apiError('INVALID_TOWER', '线路、规范杆塔号和有效顺序不能为空'), 422);
    if (before && towerNo !== before.tower_no) return c.json(apiError('RENAME_REQUIRED', '批量维护不能直接修改杆塔编号，请使用“杆塔更名”操作'), 422);
    const nextVersion = before ? Number(before.version) + 1 : 1;
    const data: TransmissionTowerSummary = { id, lineId, lineName: parent.lineName, towerNo, sortRank, towerType, enabled, version: nextVersion };
    if (before) beforeRows.push(before);
    items.push(data);
    writeItems.push({
      id,
      expectedVersion: before ? version : null,
      vacateUniqueKeys: Boolean(before && sortRank !== before.sort_rank),
      values: { lineId, towerNo, sortRank, towerType, enabled },
    });
  }
  const response = { ok: true as const, data: { items } }, now = new Date().toISOString();
  try {
    await repository.commitTowerBatch({
      lineId,
      items: writeItems,
      mutation: { key: mutation.key, actorId: c.get('currentUser').id, operation: mutation.operation, hash: mutation.hash, responseJson: JSON.stringify(response), statusCode: 201, now, auditId: crypto.randomUUID() },
      audit: { before: beforeRows, after: items },
    });
  } catch (cause) {
    const raced = await replay(c, mutation); if (raced) return raced;
    const error = String(cause);
    for (const [code, message] of Object.entries(constraintMessages)) if (error.includes(code)) return c.json(apiError(code, message), 422);
    if (error.includes('idempotency_records.request_hash')) return c.json(apiError('VERSION_CONFLICT', '数据已变化，请刷新后重试'), 409);
    if (error.includes('UNIQUE constraint')) return c.json(apiError('MASTER_DATA_CONFLICT', '名称、编码、杆塔号或线路顺序重复，请检查'), 409);
    throw cause;
  }
  return c.json(response, 201);
});
function locationType(value: unknown): DemandLocationType | null {
  return value === 'whole_line' || value === 'tower' || value === 'tower_range' ? value : null;
}

p9App.post('/demands', requireRoles('admin', 'project_manager'), async (c) => {
  let body: Partial<CreateStructuredDemandRequest> & Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const mutation = await beginMutation(c, body); if (mutation instanceof Response) return mutation;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json(apiError('INVALID_DEMAND', '请求体必须为对象'), 422);
  const sequenceNo = cleanText(body.sequenceNo, 120), voltageLevelId = cleanText(body.voltageLevelId, 120), lineId = cleanText(body.lineId, 120), type = locationType(body.locationType), materials = parseMaterials(body.materials);
  const year = body.year === null || body.year === undefined ? null : intValue(body.year, 1900, 2200);
  const category = body.category === null || body.category === undefined ? null : cleanText(body.category, 120) || null;
  const owner = body.owner === null || body.owner === undefined ? null : cleanText(body.owner, 120) || null;
  if (!sequenceNo || !voltageLevelId || !lineId || !type || materials === null || (body.year !== null && body.year !== undefined && year === null)) return c.json(apiError('INVALID_DEMAND', '需求基本信息或设备范围不完整'), 422);

  const repository = demandRepository(c);
  const line = await repository.findLine(lineId);
  if (!line || !line.enabled || !line.voltageEnabled || line.voltageLevelId !== voltageLevelId) return c.json(apiError('INVALID_LINE_RELATION', '线路不存在、已停用或不属于所选电压等级'), 422);

  const startTowerId = cleanText(body.startTowerId, 120) || null;
  const endTowerId = cleanText(body.endTowerId, 120) || null;
  if ((type === 'whole_line' && (startTowerId || endTowerId)) || (type === 'tower' && endTowerId && startTowerId !== endTowerId)) return c.json(apiError('INVALID_LOCATION_SHAPE', '全线不能指定杆塔，单塔的起止必须相同'), 422);
  let sectionText = '全线';
  let normalizedStart: string | null = null;
  let normalizedEnd: string | null = null;
  if (type !== 'whole_line') {
    if (!startTowerId) return c.json(apiError('TOWER_REQUIRED', '请选择杆塔'), 422);
    const ids = type === 'tower_range' && endTowerId ? [startTowerId, endTowerId] : [startTowerId];
    const rows = await repository.findTowers(ids);
    const map = new Map(rows.map((row) => [row.id, row]));
    const start = map.get(startTowerId), end = type === 'tower_range' ? map.get(endTowerId ?? '') : start;
    if (!start || !end || !start.enabled || !end.enabled || start.lineId !== lineId || end.lineId !== lineId) return c.json(apiError('INVALID_TOWER_RELATION', '杆塔不存在、已停用或不属于所选线路'), 422);
    if (type === 'tower_range' && start.sortRank >= end.sortRank) return c.json(apiError('INVALID_TOWER_RANGE', '区段必须选择两个不同杆塔，起始顺序必须早于终止'), 422);
    normalizedStart = start.id;
    normalizedEnd = end.id;
    sectionText = type === 'tower' ? start.towerNo : `${start.towerNo}—${end.towerNo}`;
  }

  const referencedMaterialIds = [...new Set(materials.flatMap((material) => material.materialId ? [material.materialId] : []))];
  const materialRows = await repository.findEnabledMaterials(referencedMaterialIds);
  const materialsById = new Map(materialRows.map((row) => [row.id, row]));
  if (referencedMaterialIds.some((materialId) => !materialsById.has(materialId))) return c.json(apiError('MATERIAL_NOT_FOUND', '标准物资不存在或已停用'), 422);

  const request = { sequenceNo, year, voltageLevelId, lineId, locationType: type, startTowerId: normalizedStart, endTowerId: normalizedEnd, category, owner, materials };
  const id = crypto.randomUUID(), sourceKey = `manual:${id}`, now = new Date().toISOString(), actor = c.get('currentUser');
  const businessSignature = await hashValue({ sequenceNo, year, voltageLevelId, lineId, locationType: type, startTowerId: normalizedStart, endTowerId: normalizedEnd, category });
  const materialData: DemandDetail['materials'] = [];
  const materialInsertRows = materials.map((material) => {
    const match = material.materialId ? materialsById.get(material.materialId) ?? null : null;
    const materialId = crypto.randomUUID();
    materialData.push({ id: materialId, rawModel: material.rawModel, quantityScaled: material.quantityScaled, unit: material.unit ?? null, material: match, version: 1 });
    return { id: materialId, rawModel: material.rawModel, materialId: material.materialId ?? null, quantityScaled: material.quantityScaled, unit: material.unit ?? null };
  });
  const detail: DemandDetail = {
    id, sequenceNo, year, voltageLevelId, lineId, locationType: type, startTowerId: normalizedStart, endTowerId: normalizedEnd,
    voltageRaw: line.voltageName, voltageVerified: line.voltageName, lineName: line.lineName, section: sectionText, category, owner, version: 1, createdAt: now,
    source: { type: 'manual', raw: request }, materials: materialData,
  };
  const response = { ok: true as const, data: detail };
  try {
    await repository.createStructured({
      id, sourceKey, sequenceNo, year, voltageLevelId, lineId, locationType: type,
      startTowerId: normalizedStart, endTowerId: normalizedEnd, voltageName: line.voltageName,
      lineName: line.lineName, sectionText, category, owner, businessSignature, rawJson: JSON.stringify(request),
      actorId: actor.id, now, materials: materialInsertRows,
      materialVersions: Object.fromEntries(referencedMaterialIds.map((materialId) => [materialId, materialsById.get(materialId)!.version])),
      responseJson: JSON.stringify(response), idempotencyKey: mutation.key, operation: mutation.operation,
      requestHash: mutation.hash, auditId: crypto.randomUUID(), auditAfter: detail,
    });
  } catch (cause) {
    const raced = await replay(c, mutation); if (raced) return raced;
    const error = String(cause);
    for (const [code, message] of Object.entries(constraintMessages)) if (error.includes(code)) return c.json(apiError(code, message), 422);
    if (error.includes('UNIQUE constraint')) return c.json(apiError('DEMAND_CONFLICT', '需求或来源已存在，请刷新后重试'), 409);
    throw cause;
  }
  return c.json(response, 201);
});
