import { Hono } from 'hono';
import type {
  ApiError,
  CreateStructuredDemandRequest,
  DemandDetail,
  DemandLocationType,
  DemandMaterialInput,
  TransmissionLineSummary,
  TransmissionTowerSummary,
  VoltageLevelSummary,
  VoltageSystemType,
} from '@tpm/shared';
import { requireRoles, type AppEnv } from './auth';

export const p9App = new Hono<AppEnv>();

function apiError(code: string, message: string, details?: unknown): ApiError {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function cleanText(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function boolValue(value: unknown, fallback = true): boolean | null {
  if (value === undefined) return fallback;
  return typeof value === 'boolean' ? value : null;
}

function intValue(value: unknown, min: number, max: number): number | null {
  const parsed = Number(value);
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

interface VoltageRow {
  id: string; code: string; display_name: string; system_type: VoltageSystemType; nominal_kv: number;
  sort_order: number; enabled: number; version: number;
}
interface LineRow {
  id: string; voltage_level_id: string; voltage_level_name: string; line_code: string | null; line_name: string;
  enabled: number; version: number; tower_count: number;
}
interface TowerRow {
  id: string; line_id: string; line_name: string; tower_no: string; sort_index: number; tower_type: string | null;
  enabled: number; version: number;
}

function voltageSummary(row: VoltageRow): VoltageLevelSummary {
  return { id: row.id, code: row.code, displayName: row.display_name, systemType: row.system_type, nominalKv: row.nominal_kv, sortOrder: row.sort_order, enabled: Boolean(row.enabled), version: row.version };
}
function lineSummary(row: LineRow): TransmissionLineSummary {
  return { id: row.id, voltageLevelId: row.voltage_level_id, voltageLevelName: row.voltage_level_name, lineCode: row.line_code, lineName: row.line_name, enabled: Boolean(row.enabled), version: row.version, towerCount: row.tower_count };
}
function towerSummary(row: TowerRow): TransmissionTowerSummary {
  return { id: row.id, lineId: row.line_id, lineName: row.line_name, towerNo: row.tower_no, sortIndex: row.sort_index, towerType: row.tower_type, enabled: Boolean(row.enabled), version: row.version };
}

p9App.get('/master/voltage-levels', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id,code,display_name,system_type,nominal_kv,sort_order,enabled,version FROM voltage_levels ORDER BY sort_order,nominal_kv,display_name`,
  ).all<VoltageRow>();
  return c.json({ ok: true as const, data: { items: (rows.results ?? []).map(voltageSummary) } });
});

p9App.post('/master/voltage-levels', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const displayName = cleanText(body.displayName, 40);
  const code = cleanText(body.code, 40).toUpperCase();
  const systemType = body.systemType === 'AC' || body.systemType === 'DC' ? body.systemType : null;
  const nominalKv = intValue(body.nominalKv, 1, 2000);
  const sortOrder = intValue(body.sortOrder ?? 0, 0, 100000);
  if (!displayName || !code || !systemType || nominalKv === null || sortOrder === null) return c.json(apiError('INVALID_VOLTAGE_LEVEL', '电压等级参数不完整'), 422);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await c.env.DB.prepare(`INSERT INTO voltage_levels (id,code,display_name,system_type,nominal_kv,sort_order,enabled,version,created_at,updated_at) VALUES (?,?,?,?,?,?,1,1,?,?)`)
      .bind(id, code, displayName, systemType, nominalKv, sortOrder, now, now).run();
  } catch { return c.json(apiError('VOLTAGE_LEVEL_CONFLICT', '电压等级名称或编码已存在'), 409); }
  const row = await c.env.DB.prepare(`SELECT id,code,display_name,system_type,nominal_kv,sort_order,enabled,version FROM voltage_levels WHERE id=?`).bind(id).first<VoltageRow>();
  return c.json({ ok: true as const, data: voltageSummary(row!) }, 201);
});

p9App.patch('/master/voltage-levels/:id', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expectedVersion = intValue(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER);
  const displayName = cleanText(body.displayName, 40);
  const code = cleanText(body.code, 40).toUpperCase();
  const systemType = body.systemType === 'AC' || body.systemType === 'DC' ? body.systemType : null;
  const nominalKv = intValue(body.nominalKv, 1, 2000);
  const sortOrder = intValue(body.sortOrder ?? 0, 0, 100000);
  const enabled = boolValue(body.enabled);
  if (expectedVersion === null || !displayName || !code || !systemType || nominalKv === null || sortOrder === null || enabled === null) return c.json(apiError('INVALID_VOLTAGE_LEVEL', '电压等级参数不完整'), 422);
  const result = await c.env.DB.prepare(`UPDATE voltage_levels SET code=?,display_name=?,system_type=?,nominal_kv=?,sort_order=?,enabled=?,version=version+1,updated_at=? WHERE id=? AND version=?`)
    .bind(code, displayName, systemType, nominalKv, sortOrder, enabled ? 1 : 0, new Date().toISOString(), c.req.param('id'), expectedVersion).run();
  if (!result.meta.changes) return c.json(apiError('VERSION_CONFLICT', '电压等级已变化，请刷新后重试'), 409);
  const row = await c.env.DB.prepare(`SELECT id,code,display_name,system_type,nominal_kv,sort_order,enabled,version FROM voltage_levels WHERE id=?`).bind(c.req.param('id')).first<VoltageRow>();
  return c.json({ ok: true as const, data: voltageSummary(row!) });
});

p9App.get('/master/lines', async (c) => {
  const voltageLevelId = cleanText(c.req.query('voltageLevelId'), 120);
  const where = voltageLevelId ? 'WHERE l.voltage_level_id=?' : '';
  const stmt = c.env.DB.prepare(`SELECT l.id,l.voltage_level_id,v.display_name AS voltage_level_name,l.line_code,l.line_name,l.enabled,l.version,COUNT(t.id) AS tower_count FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id LEFT JOIN transmission_towers t ON t.line_id=l.id ${where} GROUP BY l.id,l.voltage_level_id,v.display_name,l.line_code,l.line_name,l.enabled,l.version ORDER BY v.sort_order,l.line_name COLLATE NOCASE`);
  const rows = voltageLevelId ? await stmt.bind(voltageLevelId).all<LineRow>() : await stmt.all<LineRow>();
  return c.json({ ok: true as const, data: { items: (rows.results ?? []).map(lineSummary) } });
});

p9App.post('/master/lines', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const voltageLevelId = cleanText(body.voltageLevelId, 120), lineName = cleanText(body.lineName, 200), lineCode = cleanText(body.lineCode, 80) || null;
  if (!voltageLevelId || !lineName) return c.json(apiError('INVALID_LINE', '电压等级和线路名称不能为空'), 422);
  const voltage = await c.env.DB.prepare(`SELECT id FROM voltage_levels WHERE id=? AND enabled=1`).bind(voltageLevelId).first<{ id: string }>();
  if (!voltage) return c.json(apiError('VOLTAGE_LEVEL_NOT_FOUND', '电压等级不存在或已停用'), 422);
  const id = crypto.randomUUID(), now = new Date().toISOString();
  try { await c.env.DB.prepare(`INSERT INTO transmission_lines (id,voltage_level_id,line_code,line_name,enabled,version,created_at,updated_at) VALUES (?,?,?,?,1,1,?,?)`).bind(id, voltageLevelId, lineCode, lineName, now, now).run(); }
  catch { return c.json(apiError('LINE_CONFLICT', '该电压等级下已存在同名线路'), 409); }
  const row = await c.env.DB.prepare(`SELECT l.id,l.voltage_level_id,v.display_name AS voltage_level_name,l.line_code,l.line_name,l.enabled,l.version,0 AS tower_count FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id WHERE l.id=?`).bind(id).first<LineRow>();
  return c.json({ ok: true as const, data: lineSummary(row!) }, 201);
});

p9App.patch('/master/lines/:id', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expectedVersion = intValue(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER), voltageLevelId = cleanText(body.voltageLevelId, 120), lineName = cleanText(body.lineName, 200), lineCode = cleanText(body.lineCode, 80) || null, enabled = boolValue(body.enabled);
  if (expectedVersion === null || !voltageLevelId || !lineName || enabled === null) return c.json(apiError('INVALID_LINE', '线路参数不完整'), 422);
  const result = await c.env.DB.prepare(`UPDATE transmission_lines SET voltage_level_id=?,line_code=?,line_name=?,enabled=?,version=version+1,updated_at=? WHERE id=? AND version=?`)
    .bind(voltageLevelId, lineCode, lineName, enabled ? 1 : 0, new Date().toISOString(), c.req.param('id'), expectedVersion).run();
  if (!result.meta.changes) return c.json(apiError('VERSION_CONFLICT', '线路已变化，请刷新后重试'), 409);
  const row = await c.env.DB.prepare(`SELECT l.id,l.voltage_level_id,v.display_name AS voltage_level_name,l.line_code,l.line_name,l.enabled,l.version,COUNT(t.id) AS tower_count FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id LEFT JOIN transmission_towers t ON t.line_id=l.id WHERE l.id=? GROUP BY l.id,l.voltage_level_id,v.display_name,l.line_code,l.line_name,l.enabled,l.version`).bind(c.req.param('id')).first<LineRow>();
  return c.json({ ok: true as const, data: lineSummary(row!) });
});

p9App.get('/master/towers', async (c) => {
  const lineId = cleanText(c.req.query('lineId'), 120);
  const where = lineId ? 'WHERE t.line_id=?' : '';
  const stmt = c.env.DB.prepare(`SELECT t.id,t.line_id,l.line_name,t.tower_no,t.sort_index,t.tower_type,t.enabled,t.version FROM transmission_towers t JOIN transmission_lines l ON l.id=t.line_id ${where} ORDER BY l.line_name COLLATE NOCASE,t.sort_index,t.tower_no COLLATE NOCASE`);
  const rows = lineId ? await stmt.bind(lineId).all<TowerRow>() : await stmt.all<TowerRow>();
  return c.json({ ok: true as const, data: { items: (rows.results ?? []).map(towerSummary) } });
});

p9App.post('/master/towers', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const lineId = cleanText(body.lineId, 120), towerNo = cleanText(body.towerNo, 80), sortIndex = intValue(body.sortIndex, 1, 1000000), towerType = cleanText(body.towerType, 80) || null;
  if (!lineId || !towerNo || sortIndex === null) return c.json(apiError('INVALID_TOWER', '线路、杆塔号和顺序不能为空'), 422);
  const line = await c.env.DB.prepare(`SELECT id FROM transmission_lines WHERE id=? AND enabled=1`).bind(lineId).first<{ id: string }>();
  if (!line) return c.json(apiError('LINE_NOT_FOUND', '线路不存在或已停用'), 422);
  const id = crypto.randomUUID(), now = new Date().toISOString();
  try { await c.env.DB.prepare(`INSERT INTO transmission_towers (id,line_id,tower_no,sort_index,tower_type,enabled,version,created_at,updated_at) VALUES (?,?,?,?,?,1,1,?,?)`).bind(id, lineId, towerNo, sortIndex, towerType, now, now).run(); }
  catch { return c.json(apiError('TOWER_CONFLICT', '该线路下杆塔号或顺序已存在'), 409); }
  const row = await c.env.DB.prepare(`SELECT t.id,t.line_id,l.line_name,t.tower_no,t.sort_index,t.tower_type,t.enabled,t.version FROM transmission_towers t JOIN transmission_lines l ON l.id=t.line_id WHERE t.id=?`).bind(id).first<TowerRow>();
  return c.json({ ok: true as const, data: towerSummary(row!) }, 201);
});

p9App.patch('/master/towers/:id', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expectedVersion = intValue(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER), lineId = cleanText(body.lineId, 120), towerNo = cleanText(body.towerNo, 80), sortIndex = intValue(body.sortIndex, 1, 1000000), towerType = cleanText(body.towerType, 80) || null, enabled = boolValue(body.enabled);
  if (expectedVersion === null || !lineId || !towerNo || sortIndex === null || enabled === null) return c.json(apiError('INVALID_TOWER', '杆塔参数不完整'), 422);
  const result = await c.env.DB.prepare(`UPDATE transmission_towers SET line_id=?,tower_no=?,sort_index=?,tower_type=?,enabled=?,version=version+1,updated_at=? WHERE id=? AND version=?`)
    .bind(lineId, towerNo, sortIndex, towerType, enabled ? 1 : 0, new Date().toISOString(), c.req.param('id'), expectedVersion).run();
  if (!result.meta.changes) return c.json(apiError('VERSION_CONFLICT', '杆塔已变化，请刷新后重试'), 409);
  const row = await c.env.DB.prepare(`SELECT t.id,t.line_id,l.line_name,t.tower_no,t.sort_index,t.tower_type,t.enabled,t.version FROM transmission_towers t JOIN transmission_lines l ON l.id=t.line_id WHERE t.id=?`).bind(c.req.param('id')).first<TowerRow>();
  return c.json({ ok: true as const, data: towerSummary(row!) });
});

function locationType(value: unknown): DemandLocationType | null {
  return value === 'whole_line' || value === 'tower' || value === 'tower_range' ? value : null;
}

p9App.post('/demands', requireRoles('admin', 'project_manager'), async (c) => {
  let body: Partial<CreateStructuredDemandRequest> & Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const sequenceNo = cleanText(body.sequenceNo, 120), voltageLevelId = cleanText(body.voltageLevelId, 120), lineId = cleanText(body.lineId, 120), type = locationType(body.locationType), materials = parseMaterials(body.materials);
  const year = body.year === null || body.year === undefined ? null : intValue(body.year, 1900, 2200);
  const category = body.category === null || body.category === undefined ? null : cleanText(body.category, 120) || null;
  const owner = body.owner === null || body.owner === undefined ? null : cleanText(body.owner, 120) || null;
  if (!sequenceNo || !voltageLevelId || !lineId || !type || materials === null || (body.year !== null && body.year !== undefined && year === null)) return c.json(apiError('INVALID_DEMAND', '需求基本信息或设备范围不完整'), 422);

  const line = await c.env.DB.prepare(`SELECT l.id,l.line_name,l.enabled,l.voltage_level_id,v.display_name AS voltage_name,v.enabled AS voltage_enabled FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id WHERE l.id=?`).bind(lineId).first<{ id: string; line_name: string; enabled: number; voltage_level_id: string; voltage_name: string; voltage_enabled: number }>();
  if (!line || !line.enabled || !line.voltage_enabled || line.voltage_level_id !== voltageLevelId) return c.json(apiError('INVALID_LINE_RELATION', '线路不存在、已停用或不属于所选电压等级'), 422);

  const startTowerId = cleanText(body.startTowerId, 120) || null;
  const endTowerId = cleanText(body.endTowerId, 120) || null;
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
    if (type === 'tower_range' && start.sort_index > end.sort_index) return c.json(apiError('INVALID_TOWER_RANGE', '起始杆塔顺序不能晚于终止杆塔'), 422);
    normalizedStart = start.id;
    normalizedEnd = end.id;
    sectionText = type === 'tower' ? start.tower_no : `${start.tower_no}—${end.tower_no}`;
  }

  const request = { sequenceNo, year, voltageLevelId, lineId, locationType: type, startTowerId: normalizedStart, endTowerId: normalizedEnd, category, owner, materials };
  const id = crypto.randomUUID(), sourceKey = `manual:${id}`, now = new Date().toISOString(), actor = c.get('currentUser');
  const businessSignature = await hashValue({ sequenceNo, year, voltageLevelId, lineId, locationType: type, startTowerId: normalizedStart, endTowerId: normalizedEnd, category });
  const statements: D1PreparedStatement[] = [c.env.DB.prepare(
    `INSERT INTO demands (id,source_type,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,raw_json,extra_json,version,created_by,created_at,updated_at,voltage_level_id,line_id,location_type,start_tower_id,end_tower_id) VALUES (?,'manual',?,NULL,NULL,NULL,NULL,NULL,?,?,?,?,?,?,?,?,?,?,'{}',1,?,?,?,?,?,?,?,?)`,
  ).bind(id, sourceKey, sequenceNo, year, line.voltage_name, line.voltage_name, line.line_name, sectionText, category, owner, businessSignature, JSON.stringify(request), actor.id, now, now, voltageLevelId, lineId, type, normalizedStart, normalizedEnd)];
  for (const material of materials) statements.push(c.env.DB.prepare(`INSERT INTO demand_materials (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at,source_import_row_id,created_by,version) VALUES (?,?,?,?,?,?,?,NULL,?,1)`).bind(crypto.randomUUID(), id, material.rawModel, material.materialId ?? null, material.quantityScaled, material.unit ?? null, now, actor.id));
  await c.env.DB.batch(statements);
  const materialRows = await c.env.DB.prepare(`SELECT dm.id,dm.raw_model,dm.material_id,dm.quantity_scaled,dm.unit,dm.created_at,dm.version,m.id AS matched_id,m.code AS matched_code,m.name AS matched_name,m.model AS matched_model,m.unit AS matched_unit,m.enabled AS matched_enabled,m.version AS matched_version FROM demand_materials dm LEFT JOIN materials m ON m.id=dm.material_id WHERE dm.demand_id=? ORDER BY dm.created_at,dm.id`).bind(id).all<Record<string, unknown>>();
  const detail: DemandDetail = {
    id, sequenceNo, year, voltageRaw: line.voltage_name, voltageVerified: line.voltage_name, lineName: line.line_name, section: sectionText, category, owner, version: 1, createdAt: now,
    source: { type: 'manual', raw: request },
    materials: (materialRows.results ?? []).map((row) => ({ id: String(row.id), rawModel: String(row.raw_model), materialId: row.material_id ? String(row.material_id) : null, quantityScaled: Number(row.quantity_scaled), unit: row.unit ? String(row.unit) : null, createdAt: String(row.created_at), version: Number(row.version), material: row.matched_id ? { id: String(row.matched_id), code: row.matched_code ? String(row.matched_code) : null, name: String(row.matched_name), model: String(row.matched_model), unit: String(row.matched_unit), enabled: Boolean(row.matched_enabled), version: Number(row.matched_version) } : null })),
  };
  return c.json({ ok: true as const, data: detail }, 201);
});
