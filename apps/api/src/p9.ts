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
import { requireRoles, type AppEnv } from './auth';
import { gridLocationGuard } from './grid-location';
import type { CommitSingleMasterDataInput, MasterDataWriteKind } from './ports/master-data-write-repository';
import { SqlMasterDataRepository } from './repositories/sql-master-data-repository';
import { SqlMasterDataWriteRepository } from './repositories/sql-master-data-write-repository';
import { createCloudflarePersistence } from './runtime/cloudflare/persistence';

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
p9App.get('/master/lines', async (c) => {
  const page = listPage(c); if (page instanceof Response) return page;
  const voltageLevelId = cleanText(c.req.query('voltageLevelId'), 120) || null;
  const rows = await masterDataRepository(c).listLines({
    voltageLevelId,
    cursor: page.cursor ? { lineName: page.cursor[0], id: page.cursor[1] } : null,
    limit: page.limit,
  });
  const selected = rows.slice(0, page.limit), last = selected.at(-1);
  return c.json({ ok: true as const, data: { items: selected, nextCursor: rows.length > page.limit && last ? pageCursor(last.lineName,last.id) : null } });
});
p9App.get('/master/towers', async (c) => {
  const page = listPage(c); if (page instanceof Response) return page;
  const lineId = cleanText(c.req.query('lineId'), 120) || null;
  if (page.cursor && !Number.isSafeInteger(Number(page.cursor[0]))) return c.json(apiError('INVALID_CURSOR', '分页游标无效'), 400);
  const rows = await masterDataRepository(c).listTowers({
    lineId,
    cursor: page.cursor ? { sortIndex: Number(page.cursor[0]), id: page.cursor[1] } : null,
    limit: page.limit,
  });
  const selected = rows.slice(0,page.limit), last = selected.at(-1);
  return c.json({ ok: true as const, data: { items: selected, nextCursor: rows.length > page.limit && last ? pageCursor(String(last.sortIndex),last.id) : null } });
});

// The idempotency record is the first statement in the same atomic D1 batch.
// A stale version violates NOT NULL before any business write or audit is made.
type Mutation = { key: string; operation: string; hash: string };
async function beginMutation(c: Context<AppEnv>, body: unknown): Promise<Mutation | Response> {
  const key = c.req.header('Idempotency-Key')?.trim();
  if (!key || key.length > 200) return c.json(apiError('IDEMPOTENCY_KEY_REQUIRED', '变更请求必须提供有效的 Idempotency-Key'), 400);
  const mutation = { key, operation: `${c.req.method}:${c.req.path}`, hash: await hashValue(body) };
  return (await replay(c, mutation)) ?? mutation;
}
async function replay(c: Context<AppEnv>, mutation: Mutation) {
  const row = await c.env.DB.prepare('SELECT actor_member_id,operation,request_hash,response_json,status_code FROM idempotency_records WHERE idempotency_key=?')
    .bind(mutation.key).first<{ actor_member_id: string; operation: string; request_hash: string; response_json: string; status_code: number }>();
  if (!row) return null;
  if (row.actor_member_id !== c.get('currentUser').id || row.operation !== mutation.operation || row.request_hash !== mutation.hash) return c.json(apiError('IDEMPOTENCY_CONFLICT', '该 Idempotency-Key 已用于不同请求'), 409);
  return new Response(row.response_json, { status: row.status_code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
const constraintMessages: Record<string, string> = {
  VOLTAGE_LEVEL_NOT_FOUND: '电压等级不存在或已停用，请先维护基础台账',
  LINE_NOT_FOUND: '线路或所属电压等级不存在或已停用，请先维护基础台账',
  LINE_LOCATION_IN_USE: '线路已被需求或项目引用，不能更换电压等级',
  TOWER_LOCATION_IN_USE: '线路已有需求区段，不能换线、改号、调整顺序或删除杆塔；可停用',
  MASTER_DATA_IN_USE: '对象已被业务引用或仍有下级台账，不能删除；请停用',
  VOLTAGE_LOCATION_IN_USE: '电压等级已被业务引用，不能改变制式或标称电压',
  INVALID_GRID_LOCATION: '需求位置关联已变化或停用，请刷新并先维护基础台账',
};
async function commitMutation(c: Context<AppEnv>, mutation: Mutation, statements: D1PreparedStatement[], data: unknown, status: 200 | 201,
  audits: Array<{ action: string; type: string; id: string; before: unknown; after: unknown }>,
  versions: Array<{ table: string; id: string; version: number }> = []) {
  const now = new Date().toISOString(), actorId = c.get('currentUser').id, response = { ok: true as const, data };
  const condition = versions.length ? versions.map((v) => `EXISTS(SELECT 1 FROM ${v.table} WHERE id=? AND version=?)`).join(' AND ') : '1';
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at) VALUES (?,?,?,CASE WHEN ${condition} THEN ? ELSE NULL END,?,?,?)`)
        .bind(mutation.key, actorId, mutation.operation, ...versions.flatMap((v) => [v.id, v.version]), mutation.hash, JSON.stringify(response), status, now),
      ...statements,
      ...audits.map((a) => c.env.DB.prepare(`INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(crypto.randomUUID(), actorId, a.action, a.type, a.id, a.before === null ? null : JSON.stringify(a.before), a.after === null ? null : JSON.stringify(a.after), now)),
    ]);
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

type MasterKind = 'voltage-levels' | 'lines' | 'towers';
const masterTables: Record<MasterKind, string> = { 'voltage-levels': 'voltage_levels', lines: 'transmission_lines', towers: 'transmission_towers' };
type MasterRecord = Record<string, string | number | null>;
type TowerParent = { line_name: string; enabled: number; voltage_enabled: number };
async function prepareMaster(c: Context<AppEnv>, kind: MasterKind, body: Record<string, unknown>, id: string, before: MasterRecord | null, towerParent?: TowerParent) {
  const db = c.env.DB, now = new Date().toISOString(), enabled = boolValue(body.enabled);
  if (enabled === null) return c.json(apiError('INVALID_MASTER_DATA', '启用状态必须为布尔值'), 422);
  const version = before ? Number(before.version) + 1 : 1;
  let columns: string[], values: (string | number | null)[], data: VoltageLevelSummary | TransmissionLineSummary | TransmissionTowerSummary;
  if (kind === 'voltage-levels') {
    const displayName = cleanText(body.displayName, 40), code = cleanText(body.code, 40).toUpperCase();
    const systemType: 'AC' | 'DC' | null = body.systemType === 'AC' || body.systemType === 'DC' ? body.systemType : null;
    const nominalKv = intValue(body.nominalKv, 1, 2000), sortOrder = intValue(body.sortOrder ?? 0, 0, 100000);
    if (!displayName || !code || !systemType || nominalKv === null || sortOrder === null) return c.json(apiError('INVALID_VOLTAGE_LEVEL', '电压等级参数不完整'), 422);
    columns = ['code','display_name','system_type','nominal_kv','sort_order']; values = [code,displayName,systemType,nominalKv,sortOrder];
    data = { id, code, displayName, systemType, nominalKv, sortOrder, enabled, version };
  } else if (kind === 'lines') {
    const voltageLevelId = cleanText(body.voltageLevelId, 120), lineName = cleanText(body.lineName, 200), lineCode = cleanText(body.lineCode, 80) || null;
    if (!voltageLevelId || !lineName) return c.json(apiError('INVALID_LINE', '请选择电压等级并填写线路名称'), 422);
    const parent = await db.prepare('SELECT display_name,enabled FROM voltage_levels WHERE id=?').bind(voltageLevelId).first<{ display_name: string; enabled: number }>();
    if (!parent || ((!before || before.voltage_level_id !== voltageLevelId || enabled) && !parent.enabled)) return c.json(apiError('VOLTAGE_LEVEL_NOT_FOUND', constraintMessages.VOLTAGE_LEVEL_NOT_FOUND!), 422);
    columns = ['voltage_level_id','line_name','line_code']; values = [voltageLevelId,lineName,lineCode];
    const count = before ? await db.prepare('SELECT COUNT(*) AS total FROM transmission_towers WHERE line_id=?').bind(id).first<{ total: number }>() : null;
    data = { id, voltageLevelId, voltageLevelName: parent.display_name, lineName, lineCode, towerCount: count?.total ?? 0, enabled, version };
  } else {
    const lineId = cleanText(body.lineId, 120), towerNo = cleanText(body.towerNo, 80), sortIndex = intValue(body.sortIndex, 1, 1000000), towerType = cleanText(body.towerType, 80) || null;
    if (!lineId || !towerNo || sortIndex === null) return c.json(apiError('INVALID_TOWER', '线路、杆塔号和有效顺序不能为空'), 422);
    const parent = towerParent ?? await db.prepare('SELECT l.line_name,l.enabled,v.enabled AS voltage_enabled FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id WHERE l.id=?').bind(lineId).first<{ line_name: string; enabled: number; voltage_enabled: number }>();
    if (!parent || ((!before || before.line_id !== lineId || enabled) && (!parent.enabled || !parent.voltage_enabled))) return c.json(apiError('LINE_NOT_FOUND', constraintMessages.LINE_NOT_FOUND!), 422);
    columns = ['line_id','tower_no','sort_index','tower_type']; values = [lineId,towerNo,sortIndex,towerType];
    data = { id, lineId, lineName: parent.line_name, towerNo, sortIndex, towerType, enabled, version };
  }
  columns.push('enabled'); values.push(enabled ? 1 : 0);
  const table = masterTables[kind];
  const statement = before
    ? db.prepare(`UPDATE ${table} SET ${columns.map((col) => `${col}=?`).join(',')},version=version+1,updated_at=? WHERE id=?`).bind(...values, now, id)
    : db.prepare(`INSERT INTO ${table} (id,${columns.join(',')},version,created_at,updated_at) VALUES (?,${columns.map(() => '?').join(',')},1,?,?)`).bind(id, ...values, now, now);
  const parentGuard = kind === 'voltage-levels' ? null : db.prepare(`INSERT INTO master_data_guards (valid) VALUES (CASE WHEN EXISTS (SELECT 1 FROM ${kind === 'lines' ? 'voltage_levels' : 'transmission_lines'} WHERE id=? ${(!before || enabled || (kind === 'lines' ? before.voltage_level_id : before.line_id) !== values[0]) ? (kind === 'towers' ? 'AND enabled=1 AND EXISTS(SELECT 1 FROM voltage_levels WHERE id=transmission_lines.voltage_level_id AND enabled=1)' : 'AND enabled=1') : ''}) THEN 1 ELSE 0 END)`).bind(values[0]);
  return { statement, parentGuard, data, audit: { action: `master.${kind}.${before ? 'update' : 'create'}`, type: table, id, before, after: data } };
}

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
    const data: TransmissionLineSummary = { id, voltageLevelId, voltageLevelName: parent.displayName, lineName, lineCode, towerCount, enabled, version };
    return {
      values: { voltageLevelId, lineName, lineCode, enabled },
      data,
      requireEnabledParent,
      audit: { action: `master.${kind}.${before ? 'update' : 'create'}`, objectType: masterTables[kind], before, after: data },
    };
  }
  const lineId = cleanText(body.lineId, 120), towerNo = cleanText(body.towerNo, 80), sortIndex = intValue(body.sortIndex, 1, 1000000), towerType = cleanText(body.towerType, 80) || null;
  if (!lineId || !towerNo || sortIndex === null) return c.json(apiError('INVALID_TOWER', '线路、杆塔号和有效顺序不能为空'), 422);
  const parent = await repository.findTowerParent(lineId);
  const requireEnabledParent = !before || before.line_id !== lineId || enabled;
  if (!parent || (requireEnabledParent && (!parent.enabled || !parent.voltageEnabled))) return c.json(apiError('LINE_NOT_FOUND', constraintMessages.LINE_NOT_FOUND!), 422);
  const data: TransmissionTowerSummary = { id, lineId, lineName: parent.lineName, towerNo, sortIndex, towerType, enabled, version };
  return {
    values: { lineId, towerNo, sortIndex, towerType, enabled },
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
      const version = intValue(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER);
      if (method !== 'post' && version === null) return c.json(apiError('INVALID_VERSION', 'expectedVersion 必须为正整数'), 422);
      if (before && before.version !== version) return c.json(apiError('VERSION_CONFLICT', '数据已变化，请刷新后重试'), 409);
      if (method === 'delete') {
        const data = { id, deleted: true };
        return commitSingleMaster(c, mutation, {
          kind: masterWriteKinds[kind], action: 'delete', id, expectedVersion: version,
          audit: { action: `master.${kind}.delete`, objectType: masterTables[kind], before, after: null },
        }, data, 200);
      }
      const prepared = await prepareSingleMaster(c, kind, body, id, before); if (prepared instanceof Response) return prepared;
      return commitSingleMaster(c, mutation, {
        kind: masterWriteKinds[kind], action: method === 'post' ? 'create' : 'update', id,
        values: prepared.values, expectedVersion: method === 'post' ? null : version,
        requireEnabledParent: prepared.requireEnabledParent, audit: prepared.audit,
      }, prepared.data, method === 'post' ? 201 : 200);
    });
  }
}

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
    const towerNo = cleanText(item.towerNo, 80), sortIndex = intValue(item.sortIndex, 1, 1000000), towerType = cleanText(item.towerType, 80) || null, enabled = boolValue(item.enabled);
    if (!towerNo || sortIndex === null || enabled === null) return c.json(apiError('INVALID_TOWER', '线路、杆塔号和有效顺序不能为空'), 422);
    const nextVersion = before ? Number(before.version) + 1 : 1;
    const data: TransmissionTowerSummary = { id, lineId, lineName: parent.lineName, towerNo, sortIndex, towerType, enabled, version: nextVersion };
    if (before) beforeRows.push(before);
    items.push(data);
    writeItems.push({
      id,
      expectedVersion: before ? version : null,
      vacateUniqueKeys: Boolean(before && (sortIndex !== before.sort_index || towerNo !== before.tower_no)),
      values: { lineId, towerNo, sortIndex, towerType, enabled },
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

  const line = await c.env.DB.prepare(`SELECT l.id,l.line_name,l.enabled,l.voltage_level_id,v.display_name AS voltage_name,v.enabled AS voltage_enabled FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id WHERE l.id=?`).bind(lineId).first<{ id: string; line_name: string; enabled: number; voltage_level_id: string; voltage_name: string; voltage_enabled: number }>();
  if (!line || !line.enabled || !line.voltage_enabled || line.voltage_level_id !== voltageLevelId) return c.json(apiError('INVALID_LINE_RELATION', '线路不存在、已停用或不属于所选电压等级'), 422);

  const startTowerId = cleanText(body.startTowerId, 120) || null;
  const endTowerId = cleanText(body.endTowerId, 120) || null;
  if ((type === 'whole_line' && (startTowerId || endTowerId)) || (type === 'tower' && endTowerId && startTowerId !== endTowerId)) return c.json(apiError('INVALID_LOCATION_SHAPE', '全线不能指定杆塔，单塔的起止必须相同'), 422);
  let sectionText = '全线';
  let normalizedStart: string | null = null;
  let normalizedEnd: string | null = null;
  if (type !== 'whole_line') {
    if (!startTowerId) return c.json(apiError('TOWER_REQUIRED', '请选择杆塔'), 422);
    const ids = type === 'tower_range' && endTowerId ? [startTowerId, endTowerId] : [startTowerId];
    const placeholders = ids.map(() => '?').join(',');
    const rows = await c.env.DB.prepare(`SELECT id,tower_no,sort_index,line_id,enabled FROM transmission_towers WHERE id IN (${placeholders})`).bind(...ids).all<{ id: string; tower_no: string; sort_index: number; line_id: string; enabled: number }>();
    const map = new Map((rows.results ?? []).map((row) => [row.id, row]));
    const start = map.get(startTowerId), end = type === 'tower_range' ? map.get(endTowerId ?? '') : start;
    if (!start || !end || !start.enabled || !end.enabled || start.line_id !== lineId || end.line_id !== lineId) return c.json(apiError('INVALID_TOWER_RELATION', '杆塔不存在、已停用或不属于所选线路'), 422);
    if (type === 'tower_range' && start.sort_index >= end.sort_index) return c.json(apiError('INVALID_TOWER_RANGE', '区段必须选择两个不同杆塔，起始顺序必须早于终止'), 422);
    normalizedStart = start.id;
    normalizedEnd = end.id;
    sectionText = type === 'tower' ? start.tower_no : `${start.tower_no}—${end.tower_no}`;
  }

  type MaterialRow = { id: string; code: string | null; name: string; model: string; unit: string; enabled: number; version: number };
  const referencedMaterialIds = [...new Set(materials.flatMap((material) => material.materialId ? [material.materialId] : []))];
  const materialRows = referencedMaterialIds.length
    ? await c.env.DB.prepare(`SELECT id,code,name,model,unit,enabled,version FROM materials WHERE enabled=1 AND id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(referencedMaterialIds)).all<MaterialRow>()
    : { results: [] as MaterialRow[] };
  const materialsById = new Map((materialRows.results ?? []).map((row) => [row.id, row]));
  if (referencedMaterialIds.some((materialId) => !materialsById.has(materialId))) return c.json(apiError('MATERIAL_NOT_FOUND', '标准物资不存在或已停用'), 422);

  const request = { sequenceNo, year, voltageLevelId, lineId, locationType: type, startTowerId: normalizedStart, endTowerId: normalizedEnd, category, owner, materials };
  const id = crypto.randomUUID(), sourceKey = `manual:${id}`, now = new Date().toISOString(), actor = c.get('currentUser');
  const businessSignature = await hashValue({ sequenceNo, year, voltageLevelId, lineId, locationType: type, startTowerId: normalizedStart, endTowerId: normalizedEnd, category });
  const statements: D1PreparedStatement[] = [c.env.DB.prepare(
    `INSERT INTO demands (id,source_type,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,raw_json,extra_json,version,created_by,created_at,updated_at,voltage_level_id,line_id,location_type,start_tower_id,end_tower_id) VALUES (?,'manual',?,NULL,NULL,NULL,NULL,NULL,?,?,?,?,?,?,?,?,?,?,'{}',1,?,?,?,?,?,?,?,?)`,
  ).bind(id, sourceKey, sequenceNo, year, line.voltage_name, line.voltage_name, line.line_name, sectionText, category, owner, businessSignature, JSON.stringify(request), actor.id, now, now, voltageLevelId, lineId, type, normalizedStart, normalizedEnd)];
  const materialData: DemandDetail['materials'] = [];
  const materialInsertRows = materials.map((material) => {
    const match = material.materialId ? materialsById.get(material.materialId) ?? null : null;
    const materialId = crypto.randomUUID();
    materialData.push({ id: materialId, rawModel: material.rawModel, quantityScaled: material.quantityScaled, unit: material.unit ?? null, material: match ? { ...match, enabled: Boolean(match.enabled) } : null, version: 1 });
    return { id: materialId, rawModel: material.rawModel, materialId: material.materialId ?? null, quantityScaled: material.quantityScaled, unit: material.unit ?? null };
  });
  if (referencedMaterialIds.length) {
    const expectedVersions = Object.fromEntries(referencedMaterialIds.map((materialId) => [materialId, materialsById.get(materialId)!.version]));
    statements.push(c.env.DB.prepare(`INSERT INTO master_data_guards (valid) VALUES (CASE WHEN NOT EXISTS (
      SELECT 1 FROM json_each(?) expected LEFT JOIN materials m ON m.id=expected.key
      WHERE m.id IS NULL OR m.enabled<>1 OR m.version<>CAST(expected.value AS INTEGER)
    ) THEN 1 ELSE 0 END)`).bind(JSON.stringify(expectedVersions)));
  }
  if (materialInsertRows.length) statements.push(c.env.DB.prepare(`INSERT INTO demand_materials
    (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at,source_import_row_id,created_by,version)
    SELECT json_extract(value,'$.id'),?,json_extract(value,'$.rawModel'),json_extract(value,'$.materialId'),CAST(json_extract(value,'$.quantityScaled') AS INTEGER),json_extract(value,'$.unit'),?,NULL,?,1
    FROM json_each(?)`).bind(id, now, actor.id, JSON.stringify(materialInsertRows)));
  const detail: DemandDetail = {
    id, sequenceNo, year, voltageLevelId, lineId, locationType: type, startTowerId: normalizedStart, endTowerId: normalizedEnd,
    voltageRaw: line.voltage_name, voltageVerified: line.voltage_name, lineName: line.line_name, section: sectionText, category, owner, version: 1, createdAt: now,
    source: { type: 'manual', raw: request }, materials: materialData,
  };
  // Recheck the exact selected active parents/endpoints inside the write transaction.
  const gridGuard = gridLocationGuard(c.env.DB, voltageLevelId, lineId, normalizedStart, normalizedEnd, line.voltage_name, line.line_name, sectionText);
  return commitMutation(c, mutation, [gridGuard, ...statements], detail, 201, [{ action: 'demand.create.structured', type: 'demand', id, before: null, after: detail }], []);
});
