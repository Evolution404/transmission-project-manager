import { gridLocationGuard } from './grid-location';
import { Hono, type Context } from 'hono';
import type {
  ApiError,
  DemandDetail,
  DemandMaterialSummary,
  DemandSummary,
  ImportBatchSummary,
  ImportChunkRequest,
  ImportChunkResult,
  ImportFieldMapping,
  ImportIssue,
  ImportMappingTemplate,
  ImportPublishRequest,
  ImportPublishResult,
  ImportRowSummary,
  ImportValidateRequest,
  MaterialSummary,
  NormalizedImportRow,
  ParsedImportRow,
} from '@tpm/shared';
import { requireRoles, type AppEnv } from './auth';
import { SqlIdempotencyRepository } from './repositories/sql-idempotency-repository';
import { SqlImportMappingRepository } from './repositories/sql-import-mapping-repository';
import { SqlMaterialRepository } from './repositories/sql-material-repository';
import { createCloudflarePersistence } from './runtime/cloudflare/persistence';

const REQUIRED_MAPPING_KEYS = [
  'sequenceNo', 'voltage', 'lineName', 'section', 'materialModel', 'materialQuantity',
] as const;
const OPTIONAL_MAPPING_KEYS = ['unit', 'year', 'category', 'owner'] as const;
const MANUAL_DEMAND_MAPPING: ImportFieldMapping = {
  sequenceNo: 'sequenceNo',
  voltage: 'voltage',
  lineName: 'lineName',
  section: 'section',
  materialModel: 'materialModel',
  materialQuantity: 'materialQuantity',
  unit: 'unit',
  year: 'year',
  category: 'category',
  owner: 'owner',
};
const MAX_CHUNK_ROWS = 20;
const MAX_VALIDATION_ROWS = 20;
const MAX_PUBLISH_ROWS = 10;

interface ImportBatchRow {
  id: string;
  file_name: string;
  file_sha256: string;
  file_type: 'xlsx' | 'csv';
  mapping_json: string;
  status: ImportBatchSummary['status'];
  uploaded_rows: number;
  valid_rows: number;
  error_rows: number;
  warning_rows: number;
  published_rows: number;
  version: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

interface ImportRowDb {
  id: string;
  batch_id: string;
  chunk_index: number;
  sheet_name: string;
  source_row_number: number;
  source_key: string;
  raw_json: string;
  normalized_json: string | null;
  errors_json: string;
  warnings_json: string;
  row_status: ImportRowSummary['status'];
  published_demand_id: string | null;
}

interface MappingTemplateRow {
  id: string;
  name: string;
  mapping_json: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface MaterialRow {
  id: string;
  code: string | null;
  name: string;
  model: string;
  unit: string;
  enabled: number;
  version: number;
}

interface DemandRow {
  voltage_level_id: string | null;
  line_id: string | null;
  location_type: NormalizedImportRow['locationType'];
  start_tower_id: string | null;
  end_tower_id: string | null;
  id: string;
  source_type: 'import' | 'manual';
  source_key: string;
  source_batch_id: string | null;
  source_file_sha256: string | null;
  source_file_name: string | null;
  source_sheet: string | null;
  source_row_number: number | null;
  sequence_no: string;
  business_year: number | null;
  voltage_raw: string;
  voltage_verified: string | null;
  line_name: string;
  section_text: string;
  category_key: string | null;
  owner: string | null;
  raw_json: string;
  version: number;
  created_at: string;
}

function apiError(code: string, message: string, details?: unknown): ApiError {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function mappingTemplateSummary(row: MappingTemplateRow): ImportMappingTemplate {
  return {
    id: row.id,
    name: row.name,
    mapping: parseJson<ImportFieldMapping>(row.mapping_json, {} as ImportFieldMapping),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function materialSummary(row: MaterialRow): MaterialSummary {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    model: row.model,
    unit: row.unit,
    enabled: row.enabled === 1,
    version: row.version,
  };
}

function batchSummary(row: ImportBatchRow, reused = false): ImportBatchSummary {
  return {
    id: row.id,
    fileName: row.file_name,
    fileSha256: row.file_sha256,
    fileType: row.file_type,
    mapping: parseJson<ImportFieldMapping>(row.mapping_json, {} as ImportFieldMapping),
    status: row.status,
    uploadedRows: row.uploaded_rows,
    validRows: row.valid_rows,
    errorRows: row.error_rows,
    warningRows: row.warning_rows,
    publishedRows: row.published_rows,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    ...(reused ? { reused: true } : {}),
  };
}

function importRowSummary(row: ImportRowDb): ImportRowSummary {
  return {
    id: row.id,
    sheetName: row.sheet_name,
    rowNumber: row.source_row_number,
    status: row.row_status,
    normalized: parseJson<NormalizedImportRow | null>(row.normalized_json, null),
    errors: parseJson<ImportIssue[]>(row.errors_json, []),
    warnings: parseJson<ImportIssue[]>(row.warnings_json, []),
  };
}

function demandSummary(row: DemandRow): DemandSummary {
  return {
    id: row.id,
    sequenceNo: row.sequence_no,
    year: row.business_year,
    voltageLevelId: row.voltage_level_id, lineId: row.line_id, locationType: row.location_type, startTowerId: row.start_tower_id, endTowerId: row.end_tower_id,
    voltageRaw: row.voltage_raw,
    voltageVerified: row.voltage_verified,
    lineName: row.line_name,
    section: row.section_text,
    category: row.category_key,
    owner: row.owner,
    version: row.version,
    createdAt: row.created_at,
  };
}

function requireIdempotencyKey(c: Context<AppEnv>): string | Response {
  const key = c.req.header('Idempotency-Key')?.trim();
  if (!key || key.length > 200) {
    return c.json(apiError('IDEMPOTENCY_KEY_REQUIRED', '变更请求必须提供有效的 Idempotency-Key'), 400);
  }
  return key;
}

function parseExpectedVersion(value: unknown): number | null {
  const version = Number(value);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

function guardedIdempotencyInsert(
  db: D1Database,
  input: {
    key: string;
    actorId: string;
    operation: string;
    requestHash: string;
    responseJson: string;
    statusCode: number;
    now: string;
    batchId: string;
    expectedVersion: number;
    allowedStatuses: ImportBatchSummary['status'][];
  },
) {
  const statusPlaceholders = input.allowedStatuses.map(() => '?').join(',');
  return db.prepare(
    `INSERT INTO idempotency_records
      (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
     VALUES (
       ?,
       (SELECT ? WHERE EXISTS (
         SELECT 1 FROM import_batches WHERE id=? AND version=? AND status IN (${statusPlaceholders})
       )),
       ?,?,?,?,?
     )`,
  ).bind(
    input.key,
    input.actorId,
    input.batchId,
    input.expectedVersion,
    ...input.allowedStatuses,
    input.operation,
    input.requestHash,
    input.responseJson,
    input.statusCode,
    input.now,
  );
}

async function requestHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashText(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function replayIdempotentResponse(c: Context<AppEnv>, key: string, operation: string, hash: string) {
  const actor = c.get('currentUser');
  const { database } = createCloudflarePersistence(c.env);
  const row = await new SqlIdempotencyRepository(database).findByKey(key);
  if (!row) return null;
  if (row.actorMemberId !== actor.id || row.operation !== operation || row.requestHash !== hash) {
    return c.json(apiError('IDEMPOTENCY_CONFLICT', '该 Idempotency-Key 已用于不同请求'), 409);
  }
  return new Response(row.responseJson, {
    status: row.statusCode,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' },
  });
}

function isMapping(value: unknown): value is ImportFieldMapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const map = value as Record<string, unknown>;
  if (!REQUIRED_MAPPING_KEYS.every((key) => typeof map[key] === 'string' && map[key]!.trim().length > 0)) return false;
  return OPTIONAL_MAPPING_KEYS.every((key) => map[key] === undefined || (typeof map[key] === 'string' && map[key]!.trim().length > 0));
}

function cleanText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function mappedValue(cells: Record<string, unknown>, mapping: ImportFieldMapping, key: keyof ImportFieldMapping) {
  const column = mapping[key];
  return column ? cells[column] : undefined;
}

function quantityScaled(value: unknown): { scaled: number | null; error?: ImportIssue } {
  const raw = cleanText(value);
  if (!raw) return { scaled: null, error: { code: 'REQUIRED_FIELD', field: 'materialQuantity', message: '物资数量不能为空' } };
  if (raw.startsWith('-')) return { scaled: null, error: { code: 'QUANTITY_NEGATIVE', field: 'materialQuantity', message: '物资数量不能为负数' } };
  const match = raw.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return { scaled: null, error: { code: 'QUANTITY_INVALID', field: 'materialQuantity', message: '物资数量格式无效' } };
  if ((match[2]?.length ?? 0) > 4) {
    return { scaled: null, error: { code: 'QUANTITY_PRECISION', field: 'materialQuantity', message: '物资数量最多 4 位小数' } };
  }
  const scaled = Number(match[1]) * 10000 + Number((match[2] ?? '').padEnd(4, '0'));
  if (!Number.isSafeInteger(scaled) || scaled <= 0) {
    return { scaled: null, error: { code: 'QUANTITY_NON_POSITIVE', field: 'materialQuantity', message: '物资数量必须大于 0' } };
  }
  return { scaled };
}

function verifiedVoltage(raw: string): string | null {
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*[kK][vV]$/);
  if (!match) return null;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return `${match[1]}kV`;
}

function validYear(value: unknown): { year: number | null; error?: ImportIssue } {
  const raw = cleanText(value);
  if (!raw) return { year: null };
  if (!/^\d{4}$/.test(raw)) return { year: null, error: { code: 'INVALID_YEAR', field: 'year', message: '年度必须为 4 位年份' } };
  const year = Number(raw);
  if (year < 1900 || year > 2200) return { year: null, error: { code: 'INVALID_YEAR', field: 'year', message: '年度超出允许范围' } };
  return { year };
}

function materialKey(model: string, unit: string | null) {
  return `${model.trim().toLowerCase()}\u0000${(unit ?? '').trim().toLowerCase()}`;
}

function splitSectionRange(section: string): { start: string; end: string } | null {
  const match = section.match(/^\s*(.+?)\s*(?:—|–|-|~|～|至)\s*(.+?)\s*$/);
  if (!match) return null;
  const start = match[1]?.trim() ?? '';
  const end = match[2]?.trim() ?? '';
  return start && end ? { start, end } : null;
}

async function resolveGridLocation(db: D1Database, normalized: NormalizedImportRow, errors: ImportIssue[]) {
  const voltage = await db.prepare(
    `SELECT id,display_name FROM voltage_levels WHERE enabled=1 AND display_name=? COLLATE NOCASE LIMIT 1`,
  ).bind(normalized.voltageRaw).first<{ id: string; display_name: string }>();
  if (!voltage) {
    errors.push({ code: 'VOLTAGE_LEVEL_UNKNOWN', field: 'voltage', message: '电压等级不存在或已停用，请先维护基础台账' });
    return;
  }
  normalized.voltageLevelId = voltage.id;
  normalized.voltageVerified = voltage.display_name;
  normalized.voltageRaw = voltage.display_name;

  const line = await db.prepare(
    `SELECT id,line_name FROM transmission_lines WHERE enabled=1 AND voltage_level_id=? AND line_name=? COLLATE NOCASE LIMIT 1`,
  ).bind(voltage.id, normalized.lineName).first<{ id: string; line_name: string }>();
  if (!line) {
    errors.push({ code: 'LINE_UNKNOWN', field: 'lineName', message: '线路不存在或已停用，请先维护所选电压等级下的线路台账' });
    return;
  }
  normalized.lineId = line.id;
  normalized.lineName = line.line_name;

  const rawSection = normalized.section.trim();
  if (rawSection === '全线' || rawSection === '整线') {
    normalized.locationType = 'whole_line';
    normalized.startTowerId = null;
    normalized.endTowerId = null;
    normalized.section = '全线';
  } else {
    const exact = await db.prepare('SELECT id FROM transmission_towers WHERE line_id=? AND tower_no=? COLLATE NOCASE AND enabled=1').bind(line.id, rawSection).first();
    const range = exact ? null : splitSectionRange(rawSection);
    const towerNos = range ? [range.start, range.end] : [rawSection];
    const placeholders = towerNos.map(() => '?').join(',');
    const towerRows = await db.prepare(
      `SELECT id,tower_no,sort_index FROM transmission_towers WHERE enabled=1 AND line_id=? AND tower_no COLLATE NOCASE IN (${placeholders})`,
    ).bind(line.id, ...towerNos).all<{ id: string; tower_no: string; sort_index: number }>();
    const byNo = new Map((towerRows.results ?? []).map((row) => [row.tower_no.toLowerCase(), row]));
    const start = byNo.get(towerNos[0]!.toLowerCase());
    const end = byNo.get(towerNos[towerNos.length - 1]!.toLowerCase());
    if (!start || !end) {
      errors.push({ code: 'TOWER_UNKNOWN', field: 'section', message: '杆塔不存在或已停用，请先维护当前线路下的杆塔台账' });
      return;
    }
    if (range && start.sort_index >= end.sort_index) {
      errors.push({ code: 'TOWER_RANGE_REVERSED', field: 'section', message: '区段起止必须为不同杆塔，且起始顺序早于终止' });
      return;
    }
    normalized.locationType = range ? 'tower_range' : 'tower';
    normalized.startTowerId = start.id;
    normalized.endTowerId = end.id;
    normalized.section = range ? `${start.tower_no}—${end.tower_no}` : start.tower_no;
  }

  normalized.businessSignature = await hashText(JSON.stringify([
    normalized.sequenceNo,
    normalized.year,
    normalized.voltageLevelId,
    normalized.lineId,
    normalized.locationType,
    normalized.startTowerId,
    normalized.endTowerId,
    normalized.category,
  ]));
}

async function normalizeRows(
  db: D1Database,
  rows: ImportRowDb[],
  mapping: ImportFieldMapping,
): Promise<Array<{ row: ImportRowDb; normalized: NormalizedImportRow; errors: ImportIssue[]; warnings: ImportIssue[] }>> {
  const preliminary = await Promise.all(rows.map(async (row) => {
    const raw = parseJson<Record<string, unknown>>(row.raw_json, {});
    const sequenceNo = cleanText(mappedValue(raw, mapping, 'sequenceNo'));
    const voltageRaw = cleanText(mappedValue(raw, mapping, 'voltage'));
    const lineName = cleanText(mappedValue(raw, mapping, 'lineName'));
    const section = cleanText(mappedValue(raw, mapping, 'section'));
    const materialModel = cleanText(mappedValue(raw, mapping, 'materialModel'));
    const materialQuantityRaw = cleanText(mappedValue(raw, mapping, 'materialQuantity'));
    const unit = cleanText(mappedValue(raw, mapping, 'unit')) || null;
    const category = cleanText(mappedValue(raw, mapping, 'category')) || null;
    const owner = cleanText(mappedValue(raw, mapping, 'owner')) || null;
    const quantity = materialQuantityRaw ? quantityScaled(materialQuantityRaw) : { scaled: null as number | null };
    const year = validYear(mappedValue(raw, mapping, 'year'));
    const errors: ImportIssue[] = [];
    const warnings: ImportIssue[] = [];

    for (const [field, value, label] of [
      ['sequenceNo', sequenceNo, '序号'],
      ['voltage', voltageRaw, '电压等级'],
      ['lineName', lineName, '线路名称'],
      ['section', section, '杆段'],
    ] as const) {
      if (!value) errors.push({ code: 'REQUIRED_FIELD', field, message: `${label}不能为空` });
    }
    if (Boolean(materialModel) !== Boolean(materialQuantityRaw)) {
      errors.push({ code: 'MATERIAL_PAIR_INCOMPLETE', field: materialModel ? 'materialQuantity' : 'materialModel', message: '物资型号与物资数量必须同时填写；两者都留空表示该抽象需求暂未明确物资' });
    }
    if (quantity.error) errors.push(quantity.error);
    if (year.error) errors.push(year.error);
    const voltageVerified = voltageRaw ? verifiedVoltage(voltageRaw) : null;
    let businessSignature: string | null = null;
    const normalized: NormalizedImportRow = {
      sequenceNo,
      voltageRaw,
      voltageVerified,
      voltageLevelId: null,
      lineName,
      lineId: null,
      section,
      locationType: null,
      startTowerId: null,
      endTowerId: null,
      materialModel,
      quantityScaled: quantity.scaled,
      unit,
      year: year.year,
      category,
      owner,
      materialId: null,
      businessSignature,
    };
    return { row, normalized, errors, warnings };
  }));

  for (const item of preliminary) {
    if (!item.normalized.voltageRaw || !item.normalized.lineName || !item.normalized.section) continue;
    await resolveGridLocation(db, item.normalized, item.errors);
  }

  const materialPairs = new Map<string, { model: string; unit: string }>();
  for (const item of preliminary) {
    if (!item.normalized.materialModel || !item.normalized.unit) continue;
    materialPairs.set(materialKey(item.normalized.materialModel, item.normalized.unit), {
      model: item.normalized.materialModel,
      unit: item.normalized.unit,
    });
  }
  const materialMap = new Map<string, string>();
  if (materialPairs.size) {
    const clauses: string[] = [];
    const params: string[] = [];
    for (const pair of materialPairs.values()) {
      clauses.push('(model = ? COLLATE NOCASE AND unit = ? COLLATE NOCASE AND enabled = 1)');
      params.push(pair.model, pair.unit);
    }
    const result = await db.prepare(`SELECT id, model, unit FROM materials WHERE ${clauses.join(' OR ')}`).bind(...params).all<{ id: string; model: string; unit: string }>();
    for (const material of result.results ?? []) materialMap.set(materialKey(material.model, material.unit), material.id);
  }

  const signatures = preliminary.map((item) => item.normalized.businessSignature).filter((value): value is string => Boolean(value));
  const duplicates = new Set<string>();
  if (signatures.length) {
    const placeholders = signatures.map(() => '?').join(',');
    const result = await db.prepare(`SELECT DISTINCT business_signature FROM demands WHERE business_signature IN (${placeholders})`).bind(...signatures).all<{ business_signature: string }>();
    for (const existing of result.results ?? []) duplicates.add(existing.business_signature);
  }

  for (const item of preliminary) {
    if (item.normalized.materialModel) {
      const resolved = item.normalized.unit ? materialMap.get(materialKey(item.normalized.materialModel, item.normalized.unit)) ?? null : null;
      item.normalized.materialId = resolved;
      if (!resolved) item.warnings.push({ code: 'MATERIAL_UNRESOLVED', field: 'materialModel', message: '物资型号/单位尚未映射到标准物资' });
    }
    if (item.normalized.businessSignature && duplicates.has(item.normalized.businessSignature)) {
      item.warnings.push({ code: 'POSSIBLE_DUPLICATE', message: '存在业务字段相同的历史需求，请人工核对；系统不会自动删除' });
    }
  }
  return preliminary;
}

function parseCursor(value: string | undefined): { createdAt: string; id: string } | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))) as { createdAt?: unknown; id?: unknown };
    if (typeof decoded.createdAt !== 'string' || typeof decoded.id !== 'string') return null;
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch { return null; }
}

function makeCursor(createdAt: string, id: string) {
  return btoa(JSON.stringify({ createdAt, id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function findBatch(db: D1Database, id: string) {
  return db.prepare(
    `SELECT id,file_name,file_sha256,file_type,mapping_json,status,uploaded_rows,valid_rows,error_rows,warning_rows,published_rows,version,created_at,updated_at,published_at
     FROM import_batches WHERE id=? LIMIT 1`,
  ).bind(id).first<ImportBatchRow>();
}

export const p2App = new Hono<AppEnv>();

p2App.post('/import-mappings', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: { name?: unknown; mapping?: unknown };
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const name = cleanText(body.name);
  if (!name || name.length > 80 || !isMapping(body.mapping)) {
    return c.json(apiError('INVALID_MAPPING_TEMPLATE', '模板名称或字段映射无效'), 422);
  }
  const requestBody = { name, mapping: body.mapping };
  const hash = await requestHash(requestBody);
  const operation = 'import-mappings.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;

  const actor = c.get('currentUser');
  const now = new Date().toISOString();
  const data: ImportMappingTemplate = { id: crypto.randomUUID(), name, mapping: body.mapping, version: 1, createdAt: now, updatedAt: now };
  const response = { ok: true as const, data };
  const { database } = createCloudflarePersistence(c.env);
  try {
    await new SqlImportMappingRepository(database).create({
      template: data,
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    return c.json(apiError('MAPPING_TEMPLATE_EXISTS', '同名字段映射模板已存在'), 409);
  }
  return c.json(response, 201);
});

p2App.get('/import-mappings', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlImportMappingRepository(database).list() } });
});

p2App.post('/materials', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: { code?: unknown; name?: unknown; model?: unknown; unit?: unknown };
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const code = cleanText(body.code) || null;
  const name = cleanText(body.name);
  const model = cleanText(body.model);
  const unit = cleanText(body.unit);
  if (!name || !model || !unit) return c.json(apiError('INVALID_MATERIAL', '物资名称、型号和单位均不能为空'), 422);
  const requestBody = { code, name, model, unit };
  const hash = await requestHash(requestBody);
  const operation = 'materials.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const actor = c.get('currentUser');
  const now = new Date().toISOString();
  const data: MaterialSummary = { id: crypto.randomUUID(), code, name, model, unit, enabled: true, version: 1 };
  const response = { ok: true as const, data };
  const { database } = createCloudflarePersistence(c.env);
  try {
    await new SqlMaterialRepository(database).create({
      material: data,
      actorId: actor.id,
      now,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    return c.json(apiError('MATERIAL_EXISTS', '相同物资编码或型号+单位已存在'), 409);
  }
  return c.json(response, 201);
});

p2App.get('/materials', async (c) => {
  const limit = Number(c.req.query('limit') ?? '50');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.json(apiError('INVALID_PAGE_LIMIT', 'limit 必须在 1 到 100 之间'), 400);
  const query = c.req.query('query')?.trim() ?? '';
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlMaterialRepository(database).list({ query, limit }) } });
});



p2App.post('/imports', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: { fileName?: unknown; fileSha256?: unknown; fileType?: unknown; mapping?: unknown };
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const fileName = cleanText(body.fileName);
  const fileSha256 = cleanText(body.fileSha256).toLowerCase();
  const fileType = body.fileType;
  if (!fileName || !/^[a-f0-9]{64}$/.test(fileSha256) || (fileType !== 'xlsx' && fileType !== 'csv') || !isMapping(body.mapping)) {
    return c.json(apiError('INVALID_IMPORT_BATCH', '文件名、SHA-256、文件类型或字段映射无效'), 422);
  }
  const requestBody = { fileName, fileSha256, fileType, mapping: body.mapping };
  const hash = await requestHash(requestBody);
  const operation = 'imports.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const actor = c.get('currentUser');
  const existing = await c.env.DB.prepare(
    `SELECT id,file_name,file_sha256,file_type,mapping_json,status,uploaded_rows,valid_rows,error_rows,warning_rows,published_rows,version,created_at,updated_at,published_at
     FROM import_batches WHERE file_sha256=? LIMIT 1`,
  ).bind(fileSha256).first<ImportBatchRow>();
  const now = new Date().toISOString();
  if (existing) {
    const response = { ok: true as const, data: batchSummary(existing, true) };
    await c.env.DB.prepare(
      `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
       VALUES (?,?,?,?,?,200,?)`,
    ).bind(key, actor.id, operation, hash, JSON.stringify(response), now).run();
    return c.json(response);
  }

  const id = crypto.randomUUID();
  const mappingJson = JSON.stringify(body.mapping);
  const row: ImportBatchRow = {
    id, file_name: fileName, file_sha256: fileSha256, file_type: fileType,
    mapping_json: mappingJson, status: 'draft', uploaded_rows: 0, valid_rows: 0, error_rows: 0,
    warning_rows: 0, published_rows: 0, version: 1, created_at: now, updated_at: now, published_at: null,
  };
  const response = { ok: true as const, data: batchSummary(row) };
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO import_batches
         (id,file_name,file_sha256,file_type,mapping_json,status,uploaded_rows,valid_rows,error_rows,warning_rows,published_rows,version,created_by,created_at,updated_at,published_at)
         VALUES (?,?,?,?,?,'draft',0,0,0,0,0,1,?,?,?,NULL)`,
      ).bind(id, fileName, fileSha256, fileType, mappingJson, actor.id, now, now),
      c.env.DB.prepare(
        `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
         VALUES (?,?, 'import.create','import_batch',?,NULL,?,?)`,
      ).bind(crypto.randomUUID(), actor.id, id, JSON.stringify(response.data), now),
      c.env.DB.prepare(
        `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
         VALUES (?,?,?,?,?,201,?)`,
      ).bind(key, actor.id, operation, hash, JSON.stringify(response), now),
    ]);
  } catch {
    return c.json(apiError('IMPORT_CREATE_CONFLICT', '导入批次创建冲突，请刷新后重试'), 409);
  }
  return c.json(response, 201);
});

p2App.post('/imports/:id/chunks', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: Partial<ImportChunkRequest> & { expectedVersion?: unknown; chunkIndex?: unknown; rows?: unknown };
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expectedVersion = parseExpectedVersion(body.expectedVersion);
  if (expectedVersion === null || !Number.isInteger(body.chunkIndex) || Number(body.chunkIndex) < 0 || !Array.isArray(body.rows)) {
    return c.json(apiError('INVALID_IMPORT_CHUNK', 'expectedVersion、chunkIndex 或 rows 格式无效'), 422);
  }
  const rows = body.rows as ParsedImportRow[];
  if (rows.length < 1 || rows.length > MAX_CHUNK_ROWS) {
    return c.json(apiError('IMPORT_CHUNK_TOO_LARGE', `每个分片必须包含 1-${MAX_CHUNK_ROWS} 行`), 422);
  }
  for (const row of rows) {
    if (!row || typeof row.sheetName !== 'string' || !row.sheetName.trim() || !Number.isInteger(row.rowNumber) || row.rowNumber < 1 || !row.cells || typeof row.cells !== 'object' || Array.isArray(row.cells)) {
      return c.json(apiError('INVALID_IMPORT_ROW', '分片中存在格式无效的源行'), 422);
    }
    if (JSON.stringify(row.cells).length > 64_000) return c.json(apiError('IMPORT_ROW_TOO_LARGE', '单行原始数据超过 64KB'), 422);
  }
  const requestBody: ImportChunkRequest = { expectedVersion, chunkIndex: Number(body.chunkIndex), rows };
  const operation = `imports.chunk:${c.req.param('id')}`;
  const hash = await requestHash(requestBody);
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const batch = await findBatch(c.env.DB, c.req.param('id'));
  if (!batch) return c.json(apiError('IMPORT_NOT_FOUND', '导入批次不存在'), 404);
  if (batch.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '导入批次版本已变化，请刷新后重试'), 409);
  if (batch.status !== 'draft') return c.json(apiError('IMPORT_CHUNK_CLOSED', '该批次已进入校验，不能继续上传分片'), 409);

  const now = new Date().toISOString();
  const actor = c.get('currentUser');
  const sourceKeys = await Promise.all(rows.map((row) => hashText(`${batch.file_sha256}\u0000${row.sheetName.trim()}\u0000${row.rowNumber}`)));
  const data: ImportChunkResult = {
    uploadedRows: batch.uploaded_rows + rows.length,
    chunkIndex: requestBody.chunkIndex,
    version: expectedVersion + 1,
  };
  const response = { ok: true as const, data };
  const statements: D1PreparedStatement[] = [guardedIdempotencyInsert(c.env.DB, {
    key,
    actorId: actor.id,
    operation,
    requestHash: hash,
    responseJson: JSON.stringify(response),
    statusCode: 200,
    now,
    batchId: batch.id,
    expectedVersion,
    allowedStatuses: ['draft'],
  })];
  statements.push(...rows.map((row, index) => c.env.DB.prepare(
    `INSERT INTO import_rows
     (id,batch_id,chunk_index,sheet_name,source_row_number,source_key,raw_json,normalized_json,errors_json,warnings_json,row_status,published_demand_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,NULL,'[]','[]','uploaded',NULL,?,?)`,
  ).bind(
    crypto.randomUUID(), batch.id, requestBody.chunkIndex, row.sheetName.trim(), row.rowNumber, sourceKeys[index], JSON.stringify(row.cells), now, now,
  )));
  statements.push(
    c.env.DB.prepare(`UPDATE import_batches SET uploaded_rows=uploaded_rows+?, version=version+1, updated_at=? WHERE id=? AND version=? AND status='draft'`)
      .bind(rows.length, now, batch.id, expectedVersion),
  );
  try {
    const result = await c.env.DB.batch(statements);
    if (Number(result.at(-1)?.meta.changes ?? 0) !== 1) return c.json(apiError('VERSION_CONFLICT', '导入批次已变化，请刷新后重试'), 409);
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    const current = await findBatch(c.env.DB, batch.id);
    if (current && current.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '导入批次版本已变化，请刷新后重试'), 409);
    return c.json(apiError('IMPORT_ROW_CONFLICT', '源工作表行重复或批次状态已变化'), 409);
  }
  return c.json(response);
});

p2App.post('/imports/:id/validate', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: Partial<ImportValidateRequest> & { expectedVersion?: unknown };
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expectedVersion = parseExpectedVersion(body.expectedVersion);
  if (expectedVersion === null) return c.json(apiError('INVALID_IMPORT_VERSION', 'expectedVersion 必须是正整数'), 422);
  const requestBody: ImportValidateRequest = { expectedVersion };
  const operation = `imports.validate:${c.req.param('id')}`;
  const hash = await requestHash(requestBody);
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const batch = await findBatch(c.env.DB, c.req.param('id'));
  if (!batch) return c.json(apiError('IMPORT_NOT_FOUND', '导入批次不存在'), 404);
  if (batch.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '导入批次版本已变化，请刷新后重试'), 409);
  if (!['draft', 'validating'].includes(batch.status)) return c.json(apiError('IMPORT_VALIDATION_CLOSED', '该批次不能再次校验'), 409);
  if (batch.uploaded_rows === 0) return c.json(apiError('IMPORT_EMPTY', '导入批次没有源数据'), 422);

  const rowResult = await c.env.DB.prepare(
    `SELECT id,batch_id,chunk_index,sheet_name,source_row_number,source_key,raw_json,normalized_json,errors_json,warnings_json,row_status,published_demand_id
     FROM import_rows WHERE batch_id=? AND row_status='uploaded' ORDER BY source_row_number,id LIMIT ?`,
  ).bind(batch.id, MAX_VALIDATION_ROWS).all<ImportRowDb>();
  const rows = rowResult.results ?? [];
  const mapping = parseJson<ImportFieldMapping>(batch.mapping_json, {} as ImportFieldMapping);
  const normalizedRows = await normalizeRows(c.env.DB, rows, mapping);
  const validIncrement = normalizedRows.filter((item) => item.errors.length === 0).length;
  const errorIncrement = normalizedRows.length - validIncrement;
  const warningIncrement = normalizedRows.filter((item) => item.warnings.length > 0).length;
  const nextValidRows = batch.valid_rows + validIncrement;
  const nextErrorRows = batch.error_rows + errorIncrement;
  const nextWarningRows = batch.warning_rows + warningIncrement;
  const processedRows = nextValidRows + nextErrorRows;
  const remaining = Math.max(0, batch.uploaded_rows - processedRows);
  const nextStatus: ImportBatchSummary['status'] = remaining > 0 ? 'validating' : nextErrorRows > 0 ? 'review' : 'ready';
  const nextVersion = expectedVersion + 1;
  const now = new Date().toISOString();
  const actor = c.get('currentUser');
  const data = {
    ...batchSummary({
      ...batch,
      status: nextStatus,
      valid_rows: nextValidRows,
      error_rows: nextErrorRows,
      warning_rows: nextWarningRows,
      version: nextVersion,
      updated_at: now,
    }),
    done: remaining === 0,
  };
  const response = { ok: true as const, data };
  const statements: D1PreparedStatement[] = [guardedIdempotencyInsert(c.env.DB, {
    key,
    actorId: actor.id,
    operation,
    requestHash: hash,
    responseJson: JSON.stringify(response),
    statusCode: 200,
    now,
    batchId: batch.id,
    expectedVersion,
    allowedStatuses: ['draft', 'validating'],
  })];
  for (const item of normalizedRows) {
    const status = item.errors.length ? 'error' : 'valid';
    statements.push(c.env.DB.prepare(
      `UPDATE import_rows SET normalized_json=?,errors_json=?,warnings_json=?,row_status=?,updated_at=? WHERE id=? AND batch_id=?`,
    ).bind(JSON.stringify(item.normalized), JSON.stringify(item.errors), JSON.stringify(item.warnings), status, now, item.row.id, batch.id));
  }
  statements.push(c.env.DB.prepare(
    `UPDATE import_batches
     SET status=?,valid_rows=?,error_rows=?,warning_rows=?,version=version+1,updated_at=?
     WHERE id=? AND version=? AND status IN ('draft','validating')`,
  ).bind(nextStatus, nextValidRows, nextErrorRows, nextWarningRows, now, batch.id, expectedVersion));
  try {
    const result = await c.env.DB.batch(statements);
    if (Number(result.at(-1)?.meta.changes ?? 0) !== 1) return c.json(apiError('VERSION_CONFLICT', '导入批次已变化，请刷新后重试'), 409);
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    const current = await findBatch(c.env.DB, batch.id);
    if (current && current.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '导入批次版本已变化，请刷新后重试'), 409);
    return c.json(apiError('IMPORT_VALIDATION_CONFLICT', '导入校验发生并发冲突，请刷新后继续'), 409);
  }
  return c.json(response);
});

p2App.get('/imports/:id', requireRoles('admin', 'project_manager'), async (c) => {
  const batch = await findBatch(c.env.DB, c.req.param('id'));
  if (!batch) return c.json(apiError('IMPORT_NOT_FOUND', '导入批次不存在'), 404);
  const rows = await c.env.DB.prepare(
    `SELECT id,batch_id,chunk_index,sheet_name,source_row_number,source_key,raw_json,normalized_json,errors_json,warnings_json,row_status,published_demand_id
     FROM import_rows WHERE batch_id=? ORDER BY source_row_number,id LIMIT 100`,
  ).bind(batch.id).all<ImportRowDb>();
  return c.json({ ok: true as const, data: { ...batchSummary(batch), rows: (rows.results ?? []).map(importRowSummary) } });
});

p2App.post('/imports/:id/publish', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: Partial<ImportPublishRequest> & { expectedVersion?: unknown; limit?: unknown };
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expectedVersion = parseExpectedVersion(body.expectedVersion);
  if (expectedVersion === null) return c.json(apiError('INVALID_IMPORT_VERSION', 'expectedVersion 必须是正整数'), 422);
  const requestedLimit = body.limit === undefined ? MAX_PUBLISH_ROWS : Number(body.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) return c.json(apiError('INVALID_PUBLISH_LIMIT', 'limit 必须是正整数'), 400);
  const limit = Math.min(requestedLimit, MAX_PUBLISH_ROWS);
  const requestBody: ImportPublishRequest = { expectedVersion, limit: requestedLimit };
  const operation = `imports.publish:${c.req.param('id')}`;
  const hash = await requestHash(requestBody);
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const batch = await findBatch(c.env.DB, c.req.param('id'));
  if (!batch) return c.json(apiError('IMPORT_NOT_FOUND', '导入批次不存在'), 404);
  if (batch.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '导入批次版本已变化，请刷新后重试'), 409);
  if (batch.status !== 'ready' && batch.status !== 'publishing') return c.json(apiError('IMPORT_NOT_READY', '存在未完成校验或错误行，不能发布'), 422);

  const rowResult = await c.env.DB.prepare(
    `SELECT id,batch_id,chunk_index,sheet_name,source_row_number,source_key,raw_json,normalized_json,errors_json,warnings_json,row_status,published_demand_id
     FROM import_rows WHERE batch_id=? AND row_status='valid' ORDER BY source_row_number,id LIMIT ?`,
  ).bind(batch.id, limit).all<ImportRowDb>();
  const rows = rowResult.results ?? [];
  const actor = c.get('currentUser');
  const now = new Date().toISOString();
  const gridErrors: Array<{ sheetName: string; rowNumber: number; errors: ImportIssue[] }> = [];
  for (const row of rows) {
    const normalized = parseJson<NormalizedImportRow | null>(row.normalized_json, null);
    const errors: ImportIssue[] = [];
    if (!normalized) errors.push({ code: 'LOCATION_MISSING', message: '缺少位置校验结果，请重新校验' });
    else {
      const checked = { ...normalized };
      await resolveGridLocation(c.env.DB, checked, errors);
      if (!errors.length && (checked.voltageLevelId !== normalized.voltageLevelId || checked.lineId !== normalized.lineId || checked.startTowerId !== normalized.startTowerId || checked.endTowerId !== normalized.endTowerId)) errors.push({ code: 'LOCATION_CHANGED', message: '台账对象已变化，请重新校验' });
    }
    if (errors.length) gridErrors.push({ sheetName: row.sheet_name, rowNumber: row.source_row_number, errors });
  }
  if (gridErrors.length) return c.json(apiError('IMPORT_GRID_CHANGED', '台账已变化，请先维护基础台账并重新校验导入', gridErrors), 422);
  const sourceKeys = rows.map((row) => row.source_key);
  const existingBySource = new Map<string, string>();
  if (sourceKeys.length) {
    const placeholders = sourceKeys.map(() => '?').join(',');
    const direct = await c.env.DB.prepare(`SELECT id,source_key FROM demands WHERE source_key IN (${placeholders})`).bind(...sourceKeys).all<{ id: string; source_key: string }>();
    for (const demand of direct.results ?? []) existingBySource.set(demand.source_key, demand.id);
    const linked = await c.env.DB.prepare(`SELECT demand_id,source_key FROM demand_source_rows WHERE source_key IN (${placeholders})`).bind(...sourceKeys).all<{ demand_id: string; source_key: string }>();
    for (const source of linked.results ?? []) existingBySource.set(source.source_key, source.demand_id);
  }
  const signatures = rows
    .map((row) => parseJson<NormalizedImportRow | null>(row.normalized_json, null)?.businessSignature ?? null)
    .filter((value): value is string => Boolean(value));
  const existingBySignature = new Map<string, string>();
  if (signatures.length) {
    const placeholders = signatures.map(() => '?').join(',');
    const existing = await c.env.DB.prepare(
      `SELECT id,business_signature FROM demands WHERE source_type='import' AND source_batch_id=? AND business_signature IN (${placeholders})`,
    ).bind(batch.id, ...signatures).all<{ id: string; business_signature: string }>();
    for (const demand of existing.results ?? []) existingBySignature.set(demand.business_signature, demand.id);
  }

  const publishedRows = batch.published_rows + rows.length;
  const done = publishedRows >= batch.valid_rows;
  const nextStatus: ImportBatchSummary['status'] = done ? 'published' : 'publishing';
  const data: ImportPublishResult = { processed: rows.length, publishedRows, done, version: expectedVersion + 1 };
  const response = { ok: true as const, data };
  const statements: D1PreparedStatement[] = [guardedIdempotencyInsert(c.env.DB, {
    key,
    actorId: actor.id,
    operation,
    requestHash: hash,
    responseJson: JSON.stringify(response),
    statusCode: 200,
    now,
    batchId: batch.id,
    expectedVersion,
    allowedStatuses: ['ready', 'publishing'],
  })];
  for (const row of rows) {
    const normalized = parseJson<NormalizedImportRow | null>(row.normalized_json, null);
    if (!normalized || !normalized.businessSignature) {
      return c.json(apiError('IMPORT_ROW_NOT_VALIDATED', '存在缺少规范化结果的行'), 409);
    }
    statements.push(gridLocationGuard(c.env.DB, normalized.voltageLevelId!, normalized.lineId!, normalized.startTowerId, normalized.endTowerId, normalized.voltageRaw, normalized.lineName, normalized.section));
    const existingId = existingBySource.get(row.source_key) ?? existingBySignature.get(normalized.businessSignature);
    const demandId = existingId ?? crypto.randomUUID();
    if (!existingId) {
      statements.push(c.env.DB.prepare(
        `INSERT INTO demands
         (id,source_type,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,raw_json,extra_json,version,created_by,created_at,updated_at,voltage_level_id,line_id,location_type,start_tower_id,end_tower_id)
         VALUES (?,'import',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'{}',1,?,?,?,?,?,?,?,?)`,
      ).bind(
        demandId, row.source_key, batch.id, batch.file_sha256, batch.file_name, row.sheet_name, row.source_row_number,
        normalized.sequenceNo, normalized.year, normalized.voltageRaw, normalized.voltageVerified, normalized.lineName,
        normalized.section, normalized.category, normalized.owner, normalized.businessSignature, row.raw_json,
        actor.id, now, now,
        normalized.voltageLevelId, normalized.lineId, normalized.locationType, normalized.startTowerId, normalized.endTowerId,
      ));
      existingBySignature.set(normalized.businessSignature, demandId);
    }
    statements.push(c.env.DB.prepare(
      `INSERT INTO demand_source_rows
       (id,demand_id,import_row_id,source_key,file_sha256,file_name,sheet_name,source_row_number,raw_json,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(crypto.randomUUID(), demandId, row.id, row.source_key, batch.file_sha256, batch.file_name, row.sheet_name, row.source_row_number, row.raw_json, now));
    if (normalized.materialModel && normalized.quantityScaled !== null) {
      statements.push(c.env.DB.prepare(
        `INSERT INTO demand_materials
         (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at,source_import_row_id,created_by,version)
         VALUES (?,?,?,?,?,?,?,?,?,1)`,
      ).bind(crypto.randomUUID(), demandId, normalized.materialModel, normalized.materialId, normalized.quantityScaled, normalized.unit, now, row.id, actor.id));
    }
    statements.push(c.env.DB.prepare(
      `UPDATE import_rows SET row_status='published',published_demand_id=?,updated_at=? WHERE id=? AND batch_id=? AND row_status='valid'`,
    ).bind(demandId, now, row.id, batch.id));
  }

  statements.push(
    c.env.DB.prepare(
      `UPDATE import_batches
       SET status=?,published_rows=?,published_at=?,version=version+1,updated_at=?
       WHERE id=? AND version=? AND status IN ('ready','publishing')`,
    ).bind(nextStatus, publishedRows, done ? now : null, now, batch.id, expectedVersion),
    c.env.DB.prepare(
      `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
       VALUES (?,?, 'import.publish','import_batch',?,?,?,?)`,
    ).bind(crypto.randomUUID(), actor.id, batch.id, JSON.stringify({ publishedRows: batch.published_rows }), JSON.stringify(data), now),
  );
  try {
    const result = await c.env.DB.batch(statements);
    const batchUpdate = result[result.length - 2];
    if (Number(batchUpdate?.meta.changes ?? 0) !== 1) return c.json(apiError('VERSION_CONFLICT', '导入批次已被并发发布，请刷新后重试'), 409);
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    const current = await findBatch(c.env.DB, batch.id);
    if (current && current.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '导入批次版本已变化，请刷新后重试'), 409);
    return c.json(apiError('IMPORT_PUBLISH_CONFLICT', '发布发生并发冲突，请刷新后继续'), 409);
  }
  return c.json(response);
});

p2App.get('/demands', async (c) => {
  const limit = Number(c.req.query('limit') ?? '50');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.json(apiError('INVALID_PAGE_LIMIT', 'limit 必须在 1 到 100 之间'), 400);
  const query = c.req.query('query')?.trim() ?? '';
  const cursorParam = c.req.query('cursor');
  const cursor = parseCursor(cursorParam);
  if (cursorParam && !cursor) return c.json(apiError('INVALID_CURSOR', '分页游标无效'), 400);
  const where: string[] = [];
  const params: unknown[] = [];
  if (query) {
    where.push('(line_name LIKE ? OR section_text LIKE ? OR sequence_no LIKE ?)');
    const pattern = `%${query}%`;
    params.push(pattern, pattern, pattern);
  }
  if (cursor) {
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const sql = `SELECT id,source_type,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,raw_json,version,created_at,voltage_level_id,line_id,location_type,start_tower_id,end_tower_id
               FROM demands ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY created_at DESC,id DESC LIMIT ?`;
  params.push(limit + 1);
  const result = await c.env.DB.prepare(sql).bind(...params).all<DemandRow>();
  const rows = result.results ?? [];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return c.json({
    ok: true as const,
    data: {
      items: pageRows.map(demandSummary),
      nextCursor: hasMore && last ? makeCursor(last.created_at, last.id) : null,
    },
  });
});

p2App.get('/demands/:id', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT id,source_type,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,raw_json,version,created_at,voltage_level_id,line_id,location_type,start_tower_id,end_tower_id
     FROM demands WHERE id=? LIMIT 1`,
  ).bind(c.req.param('id')).first<DemandRow>();
  if (!row) return c.json(apiError('DEMAND_NOT_FOUND', '需求不存在'), 404);
  const materialRows = await c.env.DB.prepare(
    `SELECT dm.id,dm.raw_model,dm.quantity_scaled,dm.unit,
            m.id AS material_id,m.code AS material_code,m.name AS material_name,m.model AS material_model,m.unit AS material_unit,m.enabled AS material_enabled,m.version AS material_version
     FROM demand_materials dm LEFT JOIN materials m ON m.id=dm.material_id WHERE dm.demand_id=? ORDER BY dm.id`,
  ).bind(row.id).all<{
    id: string; raw_model: string; quantity_scaled: number; unit: string | null;
    material_id: string | null; material_code: string | null; material_name: string | null; material_model: string | null;
    material_unit: string | null; material_enabled: number | null; material_version: number | null;
  }>();
  const materials: DemandMaterialSummary[] = (materialRows.results ?? []).map((item) => ({
    id: item.id,
    rawModel: item.raw_model,
    quantityScaled: item.quantity_scaled,
    unit: item.unit,
    material: item.material_id && item.material_name && item.material_model && item.material_unit && item.material_version !== null
      ? {
          id: item.material_id,
          code: item.material_code,
          name: item.material_name,
          model: item.material_model,
          unit: item.material_unit,
          enabled: item.material_enabled === 1,
          version: item.material_version,
        }
      : null,
  }));
  const raw = parseJson<Record<string, unknown>>(row.raw_json, {});
  const sourceRows = row.source_type === 'import'
    ? await c.env.DB.prepare(
      `SELECT file_name,file_sha256,sheet_name,source_row_number,raw_json
       FROM demand_source_rows WHERE demand_id=? ORDER BY source_row_number,id`,
    ).bind(row.id).all<{ file_name: string; file_sha256: string; sheet_name: string; source_row_number: number; raw_json: string }>()
    : null;
  const data: DemandDetail = {
    ...demandSummary(row),
    source: row.source_type === 'manual'
      ? { type: 'manual', raw }
      : {
          type: 'import',
          batchId: row.source_batch_id!,
          fileName: row.source_file_name!,
          fileSha256: row.source_file_sha256!,
          sheetName: row.source_sheet!,
          rowNumber: row.source_row_number!,
          raw,
          rows: (sourceRows?.results ?? []).map((source) => ({
            fileName: source.file_name,
            fileSha256: source.file_sha256,
            sheetName: source.sheet_name,
            rowNumber: source.source_row_number,
            raw: parseJson<Record<string, unknown>>(source.raw_json, {}),
          })),
        },
    materials,
  };
  return c.json({ ok: true as const, data });
});
