import { Hono, type Context } from 'hono';
import type {
  ApiError,
  CreateStructuredDemandRequest,
  CustomFieldEntityType,
  CustomFieldDataType,
  CustomFieldDefinitionSummary,
  DemandDetail,
  DemandLocationType,
  DemandMaterialInput,
  LineTowerPositionSummary,
  PhysicalTowerSummary,
  TeamSummary,
  TransmissionLineSummary,
  TowerTypeSummary,
  VoltageLevelSummary,
} from '@tpm/shared';
import { CUSTOM_FIELD_ENTITY_TYPES, compareTowerNo, normalizeTowerNo } from '@tpm/shared';
import { requireRoles, type AppEnv } from './auth.ts';
import type {
  CommitMasterConfigInput,
  CommitPhysicalTowerUpdateInput,
  CommitSingleMasterDataInput,
  CustomFieldValueWrite,
  MasterConfigKind,
  MasterDataWriteKind,
} from './ports/master-data-write-repository';
import { SqlDemandRepository } from './repositories/sql-demand-repository.ts';
import { SqlIdempotencyRepository } from './repositories/sql-idempotency-repository.ts';
import { SqlMasterDataRepository } from './repositories/sql-master-data-repository.ts';
import { SqlMasterDataWriteRepository } from './repositories/sql-master-data-write-repository.ts';
import { resolvePersistence as createCloudflarePersistence } from './runtime/persistence.ts';

export const masterDataApp = new Hono<AppEnv>();

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

const customFieldDataTypes = new Set<CustomFieldDataType>(['text', 'integer', 'quantity', 'year', 'boolean', 'date', 'single_select', 'multi_select']);

function customFieldEntityType(value: unknown): CustomFieldEntityType | null {
  return typeof value === 'string' && CUSTOM_FIELD_ENTITY_TYPES.includes(value as CustomFieldEntityType)
    ? value as CustomFieldEntityType
    : null;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function compactJson(value: unknown, maxLength: number): string | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && serialized.length <= maxLength ? serialized : null;
  } catch {
    return null;
  }
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

masterDataApp.get('/master/voltage-levels', async (c) => {
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listVoltageLevels() } });
});
masterDataApp.get('/master/teams', async (c) => {
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listTeams() } });
});
masterDataApp.get('/master/tower-types', async (c) => {
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listTowerTypes() } });
});
masterDataApp.get('/master/physical-towers', async (c) => {
  const limit = Number(c.req.query('limit') ?? '100');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.json(apiError('INVALID_PAGE_LIMIT', 'limit 必须在 1–100 之间'), 400);
  const query = cleanText(c.req.query('query'), 120) || null;
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listPhysicalTowers({ query, limit }) } });
});
masterDataApp.get('/master/custom-fields', async (c) => {
  const rawEntityType = cleanText(c.req.query('entityType'), 80) || null;
  const entityType = rawEntityType ? customFieldEntityType(rawEntityType) : null;
  if (rawEntityType && !entityType) return c.json(apiError('INVALID_CUSTOM_FIELD_ENTITY', '自定义字段对象类型无效'), 422);
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listCustomFieldDefinitions(entityType) } });
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
masterDataApp.get('/master/lines', async (c) => {
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
  return c.json({ ok: true as const, data: { items: selected, nextCursor: rows.length > page.limit && last ? pageCursor(last.lineName,last.id) : null } });
});
masterDataApp.get('/master/towers', async (c) => {
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
const masterTables: Record<MasterKind, string> = { 'voltage-levels': 'voltage_levels', lines: 'transmission_lines', towers: 'line_tower_positions' };
type MasterRecord = Record<string, string | number | null>;
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
  const lineId = cleanText(body.lineId, 120), towerNo = normalizeTowerNo(cleanText(body.towerNo, 80)), sortRank = intValue(body.sortRank, 1, Number.MAX_SAFE_INTEGER), positionLabel = cleanText(body.positionLabel, 80) || null;
  if (!lineId || !towerNo || sortRank === null) return c.json(apiError('INVALID_TOWER', '线路、规范杆塔号和有效顺序不能为空'), 422);
  const parent = await repository.findTowerParent(lineId);
  const requireEnabledParent = !before || before.line_id !== lineId || enabled;
  if (!parent || (requireEnabledParent && (!parent.enabled || !parent.voltageEnabled))) return c.json(apiError('LINE_NOT_FOUND', constraintMessages.LINE_NOT_FOUND!), 422);
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
    for (const [code, message] of Object.entries(constraintMessages)) if (error.includes(code)) return c.json(apiError(code, message), 422);
    if (error.includes('idempotency_records.request_hash')) return c.json(apiError('VERSION_CONFLICT', '数据已变化，请刷新后重试'), 409);
    if (error.includes('UNIQUE constraint')) return c.json(apiError('MASTER_DATA_CONFLICT', '名称、编码、杆塔号或线路顺序重复，请检查'), 409);
    if (error.includes('FOREIGN KEY constraint')) return c.json(apiError('MASTER_DATA_IN_USE', constraintMessages.MASTER_DATA_IN_USE!), 422);
    throw cause;
  }
  return c.json(response, status);
}

type MasterConfigRoute = 'teams' | 'tower-types' | 'custom-fields';
const masterConfigKinds: Record<MasterConfigRoute, MasterConfigKind> = {
  teams: 'team',
  'tower-types': 'tower-type',
  'custom-fields': 'custom-field',
};
const masterConfigTables: Record<MasterConfigRoute, string> = {
  teams: 'teams',
  'tower-types': 'tower_types',
  'custom-fields': 'custom_field_definitions',
};

function validatedCustomFieldOptions(dataType: CustomFieldDataType, value: unknown): { value: string[] | null; json: string | null } | null {
  if (dataType !== 'single_select' && dataType !== 'multi_select') {
    return value === undefined || value === null ? { value: null, json: null } : null;
  }
  if (!Array.isArray(value) || value.length > 200) return null;
  const cleaned = value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
  if (cleaned.length !== value.length || new Set(cleaned).size !== cleaned.length || cleaned.some((item) => item.length > 120)) return null;
  const json = compactJson(cleaned, 16_000);
  return json ? { value: cleaned, json } : null;
}

function validatedCustomFieldRules(value: unknown): { value: Record<string, unknown>; json: string } | null {
  if (value === undefined || value === null) return { value: {}, json: '{}' };
  const object = plainObject(value);
  if (!object) return null;
  const allowed = new Set(['min', 'max', 'maxLength', 'minItems', 'maxItems']);
  if (Object.keys(object).some((key) => !allowed.has(key))) return null;
  for (const [key, raw] of Object.entries(object)) {
    if (key === 'min' || key === 'max') {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    } else if (!Number.isInteger(raw) || Number(raw) < 0 || Number(raw) > 100_000) return null;
  }
  if (typeof object.min === 'number' && typeof object.max === 'number' && object.min > object.max) return null;
  if (typeof object.minItems === 'number' && typeof object.maxItems === 'number' && object.minItems > object.maxItems) return null;
  const json = compactJson(object, 4_000);
  return json ? { value: object, json } : null;
}

async function prepareMasterConfig(
  c: Context<AppEnv>,
  route: MasterConfigRoute,
  body: Record<string, unknown>,
  id: string,
  before: MasterRecord | null,
) {
  const enabled = boolValue(body.enabled);
  if (enabled === null) return c.json(apiError('INVALID_MASTER_CONFIG', '启用状态必须为布尔值'), 422);
  const version = before ? Number(before.version) + 1 : 1;
  if (route === 'teams') {
    const name = cleanText(body.name, 120), code = cleanText(body.code, 80) || null;
    if (!name) return c.json(apiError('INVALID_TEAM', '班组名称不能为空'), 422);
    const data: TeamSummary = { id, code, name, enabled, version };
    return { values: { code, name, enabled }, data, audit: { action: `master.teams.${before ? 'update' : 'create'}`, objectType: 'teams', before, after: data } };
  }
  if (route === 'tower-types') {
    const label = cleanText(body.label, 120), code = cleanText(body.code, 80) || null;
    const sortOrder = intValue(body.sortOrder ?? 0, 0, 100_000);
    if (!label || sortOrder === null) return c.json(apiError('INVALID_TOWER_TYPE', '杆塔类型名称或排序无效'), 422);
    const data: TowerTypeSummary = { id, code, label, sortOrder, enabled, version };
    return { values: { code, label, sortOrder, enabled }, data, audit: { action: `master.tower-types.${before ? 'update' : 'create'}`, objectType: 'tower_types', before, after: data } };
  }
  const entityType = customFieldEntityType(body.entityType);
  const fieldKey = cleanText(body.fieldKey, 64).toLowerCase();
  const label = cleanText(body.label, 120);
  const dataType = typeof body.dataType === 'string' && customFieldDataTypes.has(body.dataType as CustomFieldDataType)
    ? body.dataType as CustomFieldDataType
    : null;
  const required = boolValue(body.required, false), filterable = boolValue(body.filterable, false);
  const sortOrder = intValue(body.sortOrder ?? 0, 0, 100_000);
  if (!entityType || !/^[a-z][a-z0-9_]{0,63}$/.test(fieldKey) || !label || !dataType || required === null || filterable === null || sortOrder === null) {
    return c.json(apiError('INVALID_CUSTOM_FIELD', '自定义字段对象、键名、名称、类型或排序无效'), 422);
  }
  const options = validatedCustomFieldOptions(dataType, body.options);
  const validation = validatedCustomFieldRules(body.validation);
  if (!options || !validation) return c.json(apiError('INVALID_CUSTOM_FIELD_RULES', '自定义字段选项或校验规则无效'), 422);
  if (before && (
    String(before.entity_type) !== entityType || String(before.field_key) !== fieldKey || String(before.data_type) !== dataType
  )) return c.json(apiError('CUSTOM_FIELD_IDENTITY_IMMUTABLE', '已创建字段不能改变对象类型、字段键或数据类型；请新建字段并停用旧字段'), 422);
  const data: CustomFieldDefinitionSummary = {
    id, entityType, fieldKey, label, dataType, required, filterable,
    options: options.value, validation: validation.value, sortOrder, enabled, version,
  };
  return {
    values: {
      entityType, fieldKey, label, dataType, required, filterable,
      optionsJson: options.json, validationJson: validation.json, sortOrder, enabled,
    },
    data,
    audit: { action: `master.custom-fields.${before ? 'update' : 'create'}`, objectType: 'custom_field_definitions', before, after: data },
  };
}

async function commitMasterConfig(
  c: Context<AppEnv>,
  mutation: Mutation,
  input: Omit<CommitMasterConfigInput, 'mutation'>,
  data: unknown,
  status: 200 | 201,
) {
  const response = { ok: true as const, data };
  const now = new Date().toISOString();
  try {
    await masterDataWriteRepository(c).commitConfig({
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
    if (error.includes('idempotency_records.request_hash')) return c.json(apiError('VERSION_CONFLICT', '配置已变化，请刷新后重试'), 409);
    if (error.includes('UNIQUE constraint')) return c.json(apiError('MASTER_CONFIG_CONFLICT', '配置名称、编码或字段键重复，请检查'), 409);
    if (error.includes('FOREIGN KEY constraint')) return c.json(apiError('MASTER_CONFIG_IN_USE', '配置已被业务数据使用，不能删除；请停用'), 422);
    throw cause;
  }
  return c.json(response, status);
}

for (const route of Object.keys(masterConfigKinds) as MasterConfigRoute[]) {
  for (const method of ['post', 'patch', 'delete'] as const) {
    masterDataApp[method](`/master/${route}${method === 'post' ? '' : '/:id'}`, requireRoles('admin'), async (c) => {
      let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
      const mutation = await beginMutation(c, body); if (mutation instanceof Response) return mutation;
      const repository = masterDataWriteRepository(c);
      const id = method === 'post' ? crypto.randomUUID() : c.req.param('id');
      const kind = masterConfigKinds[route];
      const before = method === 'post' ? null : await repository.findConfigRecord(kind, id);
      if (method !== 'post' && !before) return c.json(apiError('MASTER_CONFIG_NOT_FOUND', '配置对象不存在'), 404);
      const expectedVersion = method === 'post' ? null : intValue(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER);
      if (method !== 'post' && expectedVersion === null) return c.json(apiError('INVALID_VERSION', 'expectedVersion 必须为正整数'), 422);
      if (before && Number(before.version) !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '配置已变化，请刷新后重试'), 409);
      if (method === 'delete') {
        return commitMasterConfig(c, mutation, {
          kind, action: 'delete', id, expectedVersion,
          audit: { action: `master.${route}.delete`, objectType: masterConfigTables[route], before, after: null },
        }, { id, deleted: true }, 200);
      }
      const prepared = await prepareMasterConfig(c, route, body, id, before); if (prepared instanceof Response) return prepared;
      return commitMasterConfig(c, mutation, {
        kind,
        action: method === 'post' ? 'create' : 'update',
        id,
        values: prepared.values,
        expectedVersion,
        audit: prepared.audit,
      }, prepared.data, method === 'post' ? 201 : 200);
    });
  }
}

for (const kind of Object.keys(masterTables) as MasterKind[]) {
  for (const method of ['post', 'patch', 'delete'] as const) {
    masterDataApp[method](`/master/${kind}${method === 'post' ? '' : '/:id'}`, requireRoles('admin'), async (c) => {
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
      if (method === 'patch' && before && kind === 'towers' && cleanText(body.physicalTowerId, 120) && cleanText(body.physicalTowerId, 120) !== before.physical_tower_id) {
        return c.json(apiError('PHYSICAL_TOWER_REBIND_REQUIRED', '同塔关系变更必须使用专用“关联物理杆塔”操作'), 422);
      }
      if (method === 'patch' && before && kind === 'towers' && Number(body.sortRank) !== Number(before.sort_rank)) {
        return c.json(apiError('ORDER_MOVE_REQUIRED', '杆塔顺序变更必须使用“调整顺序”操作'), 422);
      }
      const prepared = await prepareSingleMaster(c, kind, body, id, before); if (prepared instanceof Response) return prepared;
      return commitSingleMaster(c, mutation, {
        kind: masterWriteKinds[kind], action: method === 'post' ? 'create' : 'update', id,
        values: prepared.values,
        ...(prepared.createPhysicalTower ? { createPhysicalTower: prepared.createPhysicalTower } : {}),
        expectedVersion: method === 'post' ? null : version,
        ...(towerOrderContext ? { parentLineId: towerOrderContext.lineId, expectedTowerOrderVersion: towerOrderContext.version, changesTowerOrder: true, rebalanceTowerOrder: towerOrderContext.rebalance } : {}),
        requireEnabledParent: prepared.requireEnabledParent, audit: prepared.audit,
      }, prepared.data, method === 'post' ? 201 : 200);
    });
  }
}

async function physicalTowerSummaryById(c: Context<AppEnv>, id: string): Promise<PhysicalTowerSummary | null> {
  const rows = await masterDataRepository(c).listPhysicalTowers({ query: id, limit: 100 });
  return rows.find((item) => item.id === id) ?? null;
}

masterDataApp.patch('/master/physical-towers/:id', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const mutation = await beginMutation(c, body); if (mutation instanceof Response) return mutation;
  const id = c.req.param('id'), repository = masterDataWriteRepository(c);
  const before = await repository.findPhysicalTower(id);
  if (!before) return c.json(apiError('PHYSICAL_TOWER_NOT_FOUND', '物理杆塔不存在'), 404);
  const expectedVersion = intValue(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER);
  if (expectedVersion === null) return c.json(apiError('INVALID_VERSION', 'expectedVersion 必须为正整数'), 422);
  if (Number(before.version) !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '物理杆塔已变化，请刷新后重试'), 409);

  const assetCode = body.assetCode === undefined
    ? (before.asset_code === null ? null : String(before.asset_code))
    : cleanText(body.assetCode, 120) || null;
  const towerTypeId = body.towerTypeId === undefined
    ? (before.tower_type_id === null ? null : String(before.tower_type_id))
    : body.towerTypeId === null ? null : cleanText(body.towerTypeId, 120) || null;
  const maintenanceTeamId = body.maintenanceTeamId === undefined
    ? (before.maintenance_team_id === null ? null : String(before.maintenance_team_id))
    : body.maintenanceTeamId === null ? null : cleanText(body.maintenanceTeamId, 120) || null;
  const enabled = body.enabled === undefined ? Number(before.enabled) === 1 : boolValue(body.enabled);
  if (enabled === null) return c.json(apiError('INVALID_PHYSICAL_TOWER', '启用状态必须为布尔值'), 422);

  let towerTypeLabel: string | null = null;
  if (towerTypeId) {
    const towerType = await repository.findConfigRecord('tower-type', towerTypeId);
    if (!towerType || (towerTypeId !== before.tower_type_id && Number(towerType.enabled) !== 1)) {
      return c.json(apiError('TOWER_TYPE_NOT_FOUND', '所选杆塔类型不存在或已停用'), 422);
    }
    towerTypeLabel = String(towerType.label);
  }
  let maintenanceTeamName: string | null = null;
  if (maintenanceTeamId) {
    const team = await repository.findConfigRecord('team', maintenanceTeamId);
    if (!team || (maintenanceTeamId !== before.maintenance_team_id && Number(team.enabled) !== 1)) {
      return c.json(apiError('TEAM_NOT_FOUND', '所选班组不存在或已停用'), 422);
    }
    maintenanceTeamName = String(team.name);
  }
  const current = await physicalTowerSummaryById(c, id);
  const data: PhysicalTowerSummary = {
    id,
    assetCode,
    towerTypeId,
    towerTypeLabel,
    maintenanceTeamId,
    maintenanceTeamName,
    enabled,
    version: expectedVersion + 1,
    customValues: current?.customValues ?? {},
    customFieldsVersion: current?.customFieldsVersion ?? null,
    linePositionCount: current?.linePositionCount ?? 0,
  };
  const response = { ok: true as const, data }, now = new Date().toISOString();
  try {
    await repository.commitPhysicalTowerUpdate({
      id,
      expectedVersion,
      values: { assetCode, towerTypeId, maintenanceTeamId, enabled },
      mutation: {
        key: mutation.key, actorId: c.get('currentUser').id, operation: mutation.operation, hash: mutation.hash,
        responseJson: JSON.stringify(response), statusCode: 200, now, auditId: crypto.randomUUID(),
      },
      audit: { action: 'master.physical-towers.update', objectType: 'physical_towers', before, after: data },
    });
  } catch (cause) {
    const raced = await replay(c, mutation); if (raced) return raced;
    const error = String(cause);
    if (error.includes('idempotency_records.request_hash')) return c.json(apiError('VERSION_CONFLICT', '物理杆塔已变化，请刷新后重试'), 409);
    if (error.includes('FOREIGN KEY constraint')) return c.json(apiError('PHYSICAL_TOWER_RELATION_INVALID', '物理杆塔关联的配置对象无效'), 422);
    throw cause;
  }
  return c.json(response);
});

masterDataApp.post('/master/towers/:id/rebind-physical', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const mutation = await beginMutation(c, body); if (mutation instanceof Response) return mutation;
  const id = c.req.param('id'), repository = masterDataWriteRepository(c);
  const before = await repository.findRecord('tower-position', id);
  if (!before) return c.json(apiError('MASTER_DATA_NOT_FOUND', '线路杆塔不存在'), 404);
  const expectedVersion = intValue(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER);
  const physicalTowerId = cleanText(body.physicalTowerId, 120);
  if (expectedVersion === null || !physicalTowerId) return c.json(apiError('INVALID_PHYSICAL_REBIND', '版本或目标物理杆塔无效'), 422);
  if (Number(before.version) !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '线路杆塔已变化，请刷新后重试'), 409);
  if (String(before.physical_tower_id) === physicalTowerId) return c.json(apiError('PHYSICAL_REBIND_NO_CHANGE', '当前线路杆塔已经关联该物理杆塔'), 422);
  const physical = await repository.findPhysicalTower(physicalTowerId);
  if (!physical || Number(physical.enabled) !== 1) return c.json(apiError('PHYSICAL_TOWER_NOT_FOUND', '目标物理杆塔不存在或已停用'), 422);
  const data = { id, lineId: String(before.line_id), physicalTowerId, version: expectedVersion + 1 };
  const response = { ok: true as const, data }, now = new Date().toISOString();
  try {
    await repository.commitTowerPhysicalRebind({
      id, expectedVersion, physicalTowerId,
      mutation: {
        key: mutation.key, actorId: c.get('currentUser').id, operation: mutation.operation, hash: mutation.hash,
        responseJson: JSON.stringify(response), statusCode: 200, now, auditId: crypto.randomUUID(),
      },
      audit: { action: 'master.towers.rebind-physical', objectType: 'line_tower_positions', before, after: data },
    });
  } catch (cause) {
    const raced = await replay(c, mutation); if (raced) return raced;
    if (String(cause).includes('idempotency_records.request_hash')) return c.json(apiError('VERSION_CONFLICT', '线路杆塔或物理杆塔已变化，请刷新后重试'), 409);
    throw cause;
  }
  return c.json(response);
});

function customFieldValueIsEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

function normalizeCustomFieldValue(definition: CustomFieldDefinitionSummary, raw: unknown): { normalized: unknown; write: CustomFieldValueWrite } | string {
  let normalized: unknown = raw;
  let textValue: string | null = null;
  let integerValue: number | null = null;
  let dateValue: string | null = null;
  let booleanValue: number | null = null;
  let multiSelectValues: string[] = [];
  const rules = definition.validation;
  if (definition.dataType === 'text') {
    if (typeof raw !== 'string') return `${definition.label}必须为文本`;
    normalized = raw.trim();
    if (!normalized) return `${definition.label}不能为空文本`;
    const maxLength = typeof rules.maxLength === 'number' ? rules.maxLength : 5000;
    if ((normalized as string).length > maxLength) return `${definition.label}超过最大长度 ${maxLength}`;
    textValue = normalized as string;
  } else if (definition.dataType === 'integer' || definition.dataType === 'quantity' || definition.dataType === 'year') {
    if (!Number.isSafeInteger(raw)) return `${definition.label}必须为整数`;
    const numeric = Number(raw);
    if (definition.dataType === 'year' && (numeric < 1900 || numeric > 2200)) return `${definition.label}必须在 1900–2200 之间`;
    if (typeof rules.min === 'number' && numeric < rules.min) return `${definition.label}不能小于 ${rules.min}`;
    if (typeof rules.max === 'number' && numeric > rules.max) return `${definition.label}不能大于 ${rules.max}`;
    normalized = numeric; integerValue = numeric;
  } else if (definition.dataType === 'boolean') {
    if (typeof raw !== 'boolean') return `${definition.label}必须为布尔值`;
    normalized = raw; booleanValue = raw ? 1 : 0;
  } else if (definition.dataType === 'date') {
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) return `${definition.label}必须为 YYYY-MM-DD 日期`;
    normalized = raw; dateValue = raw;
  } else if (definition.dataType === 'single_select') {
    if (typeof raw !== 'string' || !raw.trim()) return `${definition.label}必须选择一个选项`;
    const option = raw.trim(), options = Array.isArray(definition.options) ? definition.options : [];
    if (!options.includes(option)) return `${definition.label}包含未配置选项`;
    normalized = option; textValue = option;
  } else {
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || !item.trim())) return `${definition.label}必须为选项数组`;
    const values = raw.map((item) => String(item).trim());
    if (new Set(values).size !== values.length) return `${definition.label}不能包含重复选项`;
    const options = Array.isArray(definition.options) ? definition.options : [];
    if (values.some((item) => !options.includes(item))) return `${definition.label}包含未配置选项`;
    if (typeof rules.minItems === 'number' && values.length < rules.minItems) return `${definition.label}至少选择 ${rules.minItems} 项`;
    if (typeof rules.maxItems === 'number' && values.length > rules.maxItems) return `${definition.label}最多选择 ${rules.maxItems} 项`;
    normalized = values; multiSelectValues = values;
  }
  const valueJson = compactJson(normalized, 16_000);
  if (!valueJson) return `${definition.label}序列化后过大`;
  return {
    normalized,
    write: {
      fieldDefinitionId: definition.id,
      valueJson,
      textValue,
      integerValue,
      dateValue,
      booleanValue,
      multiSelectValues,
      filterable: definition.filterable,
    },
  };
}

masterDataApp.get('/master/custom-values/:entityType/:entityId', async (c) => {
  const entityType = customFieldEntityType(c.req.param('entityType'));
  const entityId = cleanText(c.req.param('entityId'), 120);
  if (!entityType || !entityId) return c.json(apiError('INVALID_CUSTOM_FIELD_ENTITY', '自定义字段对象类型或对象 ID 无效'), 422);
  if (!await masterDataWriteRepository(c).findCustomFieldEntity(entityType, entityId)) return c.json(apiError('CUSTOM_FIELD_ENTITY_NOT_FOUND', '自定义字段所属对象不存在'), 404);
  return c.json({ ok: true as const, data: await masterDataRepository(c).getCustomFieldValues(entityType, entityId) });
});

masterDataApp.put('/master/custom-values/:entityType/:entityId', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const mutation = await beginMutation(c, body); if (mutation instanceof Response) return mutation;
  const entityType = customFieldEntityType(c.req.param('entityType'));
  const entityId = cleanText(c.req.param('entityId'), 120);
  if (!entityType || !entityId) return c.json(apiError('INVALID_CUSTOM_FIELD_ENTITY', '自定义字段对象类型或对象 ID 无效'), 422);
  const repository = masterDataWriteRepository(c);
  if (!await repository.findCustomFieldEntity(entityType, entityId)) return c.json(apiError('CUSTOM_FIELD_ENTITY_NOT_FOUND', '自定义字段所属对象不存在'), 404);
  const current = await masterDataRepository(c).getCustomFieldValues(entityType, entityId);
  const expectedVersion = body.expectedVersion === null ? null : intValue(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER);
  if (body.expectedVersion !== null && expectedVersion === null) return c.json(apiError('INVALID_VERSION', 'expectedVersion 必须为 null 或正整数'), 422);
  if (current.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '自定义字段值已变化，请刷新后重试', { currentVersion: current.version }), 409);
  const rawValues = plainObject(body.values);
  if (!rawValues || Object.keys(rawValues).length > 100) return c.json(apiError('INVALID_CUSTOM_FIELD_VALUES', '自定义字段值必须为对象且最多 100 项'), 422);
  const definitions = (await masterDataRepository(c).listCustomFieldDefinitions(entityType)).filter((item) => item.enabled);
  const byKey = new Map(definitions.map((item) => [item.fieldKey, item]));
  const unknownKeys = Object.keys(rawValues).filter((key) => !byKey.has(key));
  if (unknownKeys.length) return c.json(apiError('UNKNOWN_CUSTOM_FIELD', `存在未配置字段：${unknownKeys.slice(0, 5).join('、')}`), 422);
  const normalizedValues: Record<string, unknown> = {};
  const writes: CustomFieldValueWrite[] = [];
  for (const definition of definitions) {
    const raw = rawValues[definition.fieldKey];
    if (customFieldValueIsEmpty(raw)) {
      if (definition.required) return c.json(apiError('CUSTOM_FIELD_REQUIRED', `${definition.label}不能为空`), 422);
      continue;
    }
    const parsed = normalizeCustomFieldValue(definition, raw);
    if (typeof parsed === 'string') return c.json(apiError('INVALID_CUSTOM_FIELD_VALUE', parsed), 422);
    normalizedValues[definition.fieldKey] = parsed.normalized;
    writes.push(parsed.write);
  }
  const nextVersion = (current.version ?? 0) + 1;
  const data = { entityType, entityId, version: nextVersion, values: normalizedValues };
  const response = { ok: true as const, data }, now = new Date().toISOString();
  try {
    await repository.commitCustomFieldValues({
      entityType,
      entityId,
      expectedVersion,
      values: writes,
      mutation: {
        key: mutation.key, actorId: c.get('currentUser').id, operation: mutation.operation, hash: mutation.hash,
        responseJson: JSON.stringify(response), statusCode: 200, now, auditId: crypto.randomUUID(),
      },
      audit: { action: 'master.custom-values.replace', objectType: entityType, before: current, after: data },
    });
  } catch (cause) {
    const raced = await replay(c, mutation); if (raced) return raced;
    if (String(cause).includes('idempotency_records.request_hash')) return c.json(apiError('VERSION_CONFLICT', '自定义字段值或字段定义已变化，请刷新后重试'), 409);
    throw cause;
  }
  return c.json(response);
});

masterDataApp.get('/master/lines/:id/name-history', async (c) => {
  const id = c.req.param('id');
  const record = await masterDataWriteRepository(c).findRecord('line', id);
  if (!record) return c.json(apiError('MASTER_DATA_NOT_FOUND', '线路不存在'), 404);
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listLineNameHistory(id) } });
});

masterDataApp.get('/master/towers/:id/number-history', async (c) => {
  const id = c.req.param('id');
  const record = await masterDataWriteRepository(c).findRecord('tower-position', id);
  if (!record) return c.json(apiError('MASTER_DATA_NOT_FOUND', '杆塔不存在'), 404);
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listTowerPositionNoHistory(id) } });
});

masterDataApp.post('/master/lines/:id/rename', requireRoles('admin'), async (c) => {
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

masterDataApp.post('/master/towers/:id/rename', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
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
  if (!parent) return c.json(apiError('LINE_NOT_FOUND', constraintMessages.LINE_NOT_FOUND!), 422);
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

masterDataApp.post('/master/lines/:lineId/towers/:towerId/move', requireRoles('admin'), async (c) => {
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
      audit: { action: 'master.towers.move', objectType: 'line_tower_positions', before: { towerId, order: originalIds }, after: { towerId, order: nextOrder.map((item) => item.id) } },
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

masterDataApp.post('/master/lines/:id/towers/import-chunk', requireRoles('admin'), async (c) => {
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
    for (const [code, message] of Object.entries(constraintMessages)) if (error.includes(code)) return c.json(apiError(code, message), 422);
    if (error.includes('idempotency_records.request_hash') || error.includes('UNIQUE constraint')) return c.json(apiError('ORDER_VERSION_CONFLICT', '杆塔顺序或数据已变化，请重新预览后重试'), 409);
    throw cause;
  }
  return c.json(response, 201);
});

masterDataApp.post('/master/lines/:id/towers/reorder', requireRoles('admin'), async (c) => {
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

function locationType(value: unknown): DemandLocationType | null {
  return value === 'whole_line' || value === 'tower' || value === 'tower_range' ? value : null;
}

masterDataApp.post('/demands', requireRoles('admin', 'project_manager'), async (c) => {
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

  const startTowerPositionId = cleanText(body.startTowerPositionId, 120) || null;
  const endTowerPositionId = cleanText(body.endTowerPositionId, 120) || null;
  if ((type === 'whole_line' && (startTowerPositionId || endTowerPositionId)) || (type === 'tower' && endTowerPositionId && startTowerPositionId !== endTowerPositionId)) return c.json(apiError('INVALID_LOCATION_SHAPE', '全线不能指定杆塔，单塔的起止必须相同'), 422);
  let sectionText = '全线';
  let normalizedStart: string | null = null;
  let normalizedEnd: string | null = null;
  if (type !== 'whole_line') {
    if (!startTowerPositionId) return c.json(apiError('TOWER_REQUIRED', '请选择杆塔'), 422);
    const ids = type === 'tower_range' && endTowerPositionId ? [startTowerPositionId, endTowerPositionId] : [startTowerPositionId];
    const rows = await repository.findTowerPositions(ids);
    const map = new Map(rows.map((row) => [row.id, row]));
    const start = map.get(startTowerPositionId), end = type === 'tower_range' ? map.get(endTowerPositionId ?? '') : start;
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

  const request = { sequenceNo, year, voltageLevelId, lineId, locationType: type, startTowerPositionId: normalizedStart, endTowerPositionId: normalizedEnd, category, owner, materials };
  const id = crypto.randomUUID(), sourceKey = `manual:${id}`, now = new Date().toISOString(), actor = c.get('currentUser');
  const businessSignature = await hashValue({ sequenceNo, year, voltageLevelId, lineId, locationType: type, startTowerPositionId: normalizedStart, endTowerPositionId: normalizedEnd, category });
  const materialData: DemandDetail['materials'] = [];
  const materialInsertRows = materials.map((material) => {
    const match = material.materialId ? materialsById.get(material.materialId) ?? null : null;
    const materialId = crypto.randomUUID();
    materialData.push({ id: materialId, rawModel: material.rawModel, quantityScaled: material.quantityScaled, unit: material.unit ?? null, material: match, version: 1 });
    return { id: materialId, rawModel: material.rawModel, materialId: material.materialId ?? null, quantityScaled: material.quantityScaled, unit: material.unit ?? null };
  });
  const detail: DemandDetail = {
    id, sequenceNo, year, voltageLevelId, lineId, locationType: type, startTowerPositionId: normalizedStart, endTowerPositionId: normalizedEnd,
    voltageRaw: line.voltageName, voltageVerified: line.voltageName, lineName: line.lineName, section: sectionText, category, owner, version: 1, createdAt: now,
    source: { type: 'manual', raw: request }, materials: materialData,
  };
  const response = { ok: true as const, data: detail };
  try {
    await repository.createStructured({
      id, sourceKey, sequenceNo, year, voltageLevelId, lineId, locationType: type,
      startTowerPositionId: normalizedStart, endTowerPositionId: normalizedEnd, voltageName: line.voltageName,
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
