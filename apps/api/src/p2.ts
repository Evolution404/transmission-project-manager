import { Hono, type Context } from 'hono';
import type {
  ApiError,
  ImportBatchSummary,
  ImportChunkRequest,
  ImportChunkResult,
  ImportFieldMapping,
  ImportIssue,
  ImportMappingTemplate,
  ImportPublishRequest,
  ImportPublishResult,
  ImportValidateRequest,
  MaterialSummary,
  NormalizedImportRow,
  ParsedImportRow,
} from '@tpm/shared';
import { normalizeTowerNo } from '@tpm/shared';
import { requireRoles, type AppEnv } from './auth.ts';
import { SqlDemandQueryRepository } from './repositories/sql-demand-query-repository.ts';
import { SqlIdempotencyRepository } from './repositories/sql-idempotency-repository.ts';
import { SqlImportMappingRepository } from './repositories/sql-import-mapping-repository.ts';
import { SqlImportRepository } from './repositories/sql-import-repository.ts';
import { SqlImportPublishRepository } from './repositories/sql-import-publish-repository.ts';
import { SqlImportValidationRepository } from './repositories/sql-import-validation-repository.ts';
import type { ImportValidationRepository, ImportValidationRow } from './ports/import-validation-repository';
import { SqlMaterialRepository } from './repositories/sql-material-repository.ts';
import { resolvePersistence as createCloudflarePersistence } from './runtime/persistence.ts';

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

function apiError(code: string, message: string, details?: unknown): ApiError {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
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

async function resolveGridLocation(repository: ImportValidationRepository, normalized: NormalizedImportRow, errors: ImportIssue[]) {
  const voltage = await repository.findVoltageByName(normalized.voltageRaw);
  if (!voltage) {
    errors.push({ code: 'VOLTAGE_LEVEL_UNKNOWN', field: 'voltage', message: '电压等级不存在或已停用，请先维护基础台账' });
    return;
  }
  normalized.voltageLevelId = voltage.id;
  normalized.voltageVerified = voltage.displayName;
  normalized.voltageRaw = voltage.displayName;

  const lines = await repository.findLinesByName(voltage.id, normalized.lineName);
  if (!lines.length) {
    errors.push({ code: 'LINE_UNKNOWN', field: 'lineName', message: '线路不存在或已停用，请先维护所选电压等级下的线路台账' });
    return;
  }
  if (lines.length > 1) {
    errors.push({ code: 'LINE_AMBIGUOUS', field: 'lineName', message: '线路名称匹配到多个对象，请在基础台账中核对后再导入' });
    return;
  }
  const line = lines[0]!;
  normalized.lineId = line.id;
  normalized.lineName = line.lineName;

  const rawSection = normalized.section.trim();
  if (rawSection === '全线' || rawSection === '整线') {
    normalized.locationType = 'whole_line';
    normalized.startTowerPositionId = null;
    normalized.endTowerPositionId = null;
    normalized.section = '全线';
  } else {
    const exactTowerNo = normalizeTowerNo(rawSection);
    const exactRows = exactTowerNo ? await repository.findTowersByNumbers(line.id, [exactTowerNo]) : [];
    if (exactRows.length > 1) {
      errors.push({ code: 'TOWER_AMBIGUOUS', field: 'section', message: '杆塔编号匹配到多个对象，请在基础台账中核对后再导入' });
      return;
    }
    const range = exactRows.length ? null : splitSectionRange(rawSection);
    const towerNos = range
      ? [normalizeTowerNo(range.start), normalizeTowerNo(range.end)]
      : [exactTowerNo];
    if (towerNos.some((towerNo) => !towerNo)) {
      errors.push({ code: 'TOWER_NUMBER_INVALID', field: 'section', message: '杆塔编号格式无法识别，请使用如 10、10-1 或 #010 的格式' });
      return;
    }
    const canonicalTowerNos = towerNos as string[];
    const towerRows = range ? await repository.findTowersByNumbers(line.id, canonicalTowerNos) : exactRows;
    const grouped = new Map<string, typeof towerRows>();
    for (const row of towerRows) {
      const key = row.towerNo.toLowerCase();
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    if (canonicalTowerNos.some((towerNo) => (grouped.get(towerNo.toLowerCase())?.length ?? 0) > 1)) {
      errors.push({ code: 'TOWER_AMBIGUOUS', field: 'section', message: '杆塔编号匹配到多个对象，请在基础台账中核对后再导入' });
      return;
    }
    const start = grouped.get(canonicalTowerNos[0]!.toLowerCase())?.[0];
    const end = grouped.get(canonicalTowerNos[canonicalTowerNos.length - 1]!.toLowerCase())?.[0];
    if (!start || !end) {
      errors.push({ code: 'TOWER_UNKNOWN', field: 'section', message: '杆塔不存在或已停用，请先维护当前线路下的杆塔台账' });
      return;
    }
    if (range && start.sortRank >= end.sortRank) {
      errors.push({ code: 'TOWER_RANGE_REVERSED', field: 'section', message: '区段起止必须为不同杆塔，且起始顺序早于终止' });
      return;
    }
    normalized.locationType = range ? 'tower_range' : 'tower';
    normalized.startTowerPositionId = start.id;
    normalized.endTowerPositionId = end.id;
    normalized.section = range ? `${start.towerNo}—${end.towerNo}` : start.towerNo;
  }

  normalized.businessSignature = await hashText(JSON.stringify([
    normalized.sequenceNo,
    normalized.year,
    normalized.voltageLevelId,
    normalized.lineId,
    normalized.locationType,
    normalized.startTowerPositionId,
    normalized.endTowerPositionId,
    normalized.category,
  ]));
}

async function normalizeRows(
  repository: ImportValidationRepository,
  rows: readonly ImportValidationRow[],
  mapping: ImportFieldMapping,
): Promise<Array<{ row: ImportValidationRow; normalized: NormalizedImportRow; errors: ImportIssue[]; warnings: ImportIssue[] }>> {
  const preliminary = await Promise.all(rows.map(async (row) => {
    const raw = parseJson<Record<string, unknown>>(row.rawJson, {});
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
      startTowerPositionId: null,
      endTowerPositionId: null,
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
    await resolveGridLocation(repository, item.normalized, item.errors);
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
    const result = await repository.findMaterials([...materialPairs.values()]);
    for (const material of result) materialMap.set(materialKey(material.model, material.unit), material.id);
  }

  const signatures = preliminary.map((item) => item.normalized.businessSignature).filter((value): value is string => Boolean(value));
  const duplicates = new Set(await repository.findExistingBusinessSignatures(signatures));

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
  const now = new Date().toISOString();
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlImportRepository(database);
  const existing = await repository.findByFileHash(fileSha256);
  if (existing) {
    const response = { ok: true as const, data: { ...existing, reused: true as const } };
    await repository.recordReuse({ idempotencyKey: key, actorId: actor.id, operation, requestHash: hash, responseJson: JSON.stringify(response), now });
    return c.json(response);
  }

  const data: ImportBatchSummary = {
    id: crypto.randomUUID(), fileName, fileSha256, fileType, mapping: body.mapping,
    status: 'draft', uploadedRows: 0, validRows: 0, errorRows: 0, warningRows: 0, publishedRows: 0,
    version: 1, createdAt: now, updatedAt: now, publishedAt: null,
  };
  const response = { ok: true as const, data };
  try {
    await repository.create({
      batch: data,
      actorId: actor.id,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
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
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlImportRepository(database);
  const batch = await repository.findById(c.req.param('id'));
  if (!batch) return c.json(apiError('IMPORT_NOT_FOUND', '导入批次不存在'), 404);
  if (batch.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '导入批次版本已变化，请刷新后重试'), 409);
  if (batch.status !== 'draft') return c.json(apiError('IMPORT_CHUNK_CLOSED', '该批次已进入校验，不能继续上传分片'), 409);

  const now = new Date().toISOString();
  const actor = c.get('currentUser');
  const sourceKeys = await Promise.all(rows.map((row) => hashText(`${batch.fileSha256}\u0000${row.sheetName.trim()}\u0000${row.rowNumber}`)));
  const data: ImportChunkResult = {
    uploadedRows: batch.uploadedRows + rows.length,
    chunkIndex: requestBody.chunkIndex,
    version: expectedVersion + 1,
  };
  const response = { ok: true as const, data };
  try {
    await repository.uploadChunk({
      batchId: batch.id,
      expectedVersion,
      chunkIndex: requestBody.chunkIndex,
      actorId: actor.id,
      now,
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
      rows: rows.map((row, index) => ({
        id: crypto.randomUUID(),
        sheetName: row.sheetName.trim(),
        rowNumber: row.rowNumber,
        sourceKey: sourceKeys[index]!,
        rawJson: JSON.stringify(row.cells),
      })),
    });
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    const current = await repository.findById(batch.id);
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
  const { database } = createCloudflarePersistence(c.env);
  const importRepository = new SqlImportRepository(database);
  const validationRepository = new SqlImportValidationRepository(database);
  const batch = await importRepository.findById(c.req.param('id'));
  if (!batch) return c.json(apiError('IMPORT_NOT_FOUND', '导入批次不存在'), 404);
  if (batch.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '导入批次版本已变化，请刷新后重试'), 409);
  if (!['draft', 'validating'].includes(batch.status)) return c.json(apiError('IMPORT_VALIDATION_CLOSED', '该批次不能再次校验'), 409);
  if (batch.uploadedRows === 0) return c.json(apiError('IMPORT_EMPTY', '导入批次没有源数据'), 422);

  const rows = await validationRepository.listUploadedRows(batch.id, MAX_VALIDATION_ROWS);
  const normalizedRows = await normalizeRows(validationRepository, rows, batch.mapping);
  const validIncrement = normalizedRows.filter((item) => item.errors.length === 0).length;
  const errorIncrement = normalizedRows.length - validIncrement;
  const warningIncrement = normalizedRows.filter((item) => item.warnings.length > 0).length;
  const nextValidRows = batch.validRows + validIncrement;
  const nextErrorRows = batch.errorRows + errorIncrement;
  const nextWarningRows = batch.warningRows + warningIncrement;
  const processedRows = nextValidRows + nextErrorRows;
  const remaining = Math.max(0, batch.uploadedRows - processedRows);
  const nextStatus: ImportBatchSummary['status'] = remaining > 0 ? 'validating' : nextErrorRows > 0 ? 'review' : 'ready';
  const now = new Date().toISOString();
  const actor = c.get('currentUser');
  const data = {
    ...batch,
    status: nextStatus,
    validRows: nextValidRows,
    errorRows: nextErrorRows,
    warningRows: nextWarningRows,
    version: expectedVersion + 1,
    updatedAt: now,
    done: remaining === 0,
  };
  const response = { ok: true as const, data };
  try {
    await validationRepository.commitValidation({
      batchId: batch.id,
      expectedVersion,
      actorId: actor.id,
      now,
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
      nextStatus,
      validRows: nextValidRows,
      errorRows: nextErrorRows,
      warningRows: nextWarningRows,
      rows: normalizedRows.map((item) => ({
        id: item.row.id,
        normalizedJson: JSON.stringify(item.normalized),
        errorsJson: JSON.stringify(item.errors),
        warningsJson: JSON.stringify(item.warnings),
        status: item.errors.length ? 'error' : 'valid',
      })),
    });
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    const current = await importRepository.findById(batch.id);
    if (current && current.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '导入批次版本已变化，请刷新后重试'), 409);
    return c.json(apiError('IMPORT_VALIDATION_CONFLICT', '导入校验发生并发冲突，请刷新后继续'), 409);
  }
  return c.json(response);
});

p2App.get('/imports/:id', requireRoles('admin', 'project_manager'), async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlImportRepository(database);
  const batch = await repository.findById(c.req.param('id'));
  if (!batch) return c.json(apiError('IMPORT_NOT_FOUND', '导入批次不存在'), 404);
  const rows = await repository.listRows(batch.id, 100);
  return c.json({ ok: true as const, data: { ...batch, rows } });
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
  const { database } = createCloudflarePersistence(c.env);
  const importRepository = new SqlImportRepository(database);
  const publishRepository = new SqlImportPublishRepository(database);
  const publishValidationRepository = new SqlImportValidationRepository(database);
  const batch = await importRepository.findById(c.req.param('id'));
  if (!batch) return c.json(apiError('IMPORT_NOT_FOUND', '导入批次不存在'), 404);
  if (batch.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '导入批次版本已变化，请刷新后重试'), 409);
  if (batch.status !== 'ready' && batch.status !== 'publishing') return c.json(apiError('IMPORT_NOT_READY', '存在未完成校验或错误行，不能发布'), 422);

  const rows = await publishRepository.listValidRows(batch.id, limit);
  const actor = c.get('currentUser');
  const now = new Date().toISOString();
  const gridErrors: Array<{ sheetName: string; rowNumber: number; errors: ImportIssue[] }> = [];
  for (const row of rows) {
    const normalized = parseJson<NormalizedImportRow | null>(row.normalizedJson, null);
    const errors: ImportIssue[] = [];
    if (!normalized) errors.push({ code: 'LOCATION_MISSING', message: '缺少位置校验结果，请重新校验' });
    else {
      const checked = { ...normalized };
      await resolveGridLocation(publishValidationRepository, checked, errors);
      if (!errors.length && (checked.voltageLevelId !== normalized.voltageLevelId || checked.lineId !== normalized.lineId || checked.startTowerPositionId !== normalized.startTowerPositionId || checked.endTowerPositionId !== normalized.endTowerPositionId)) errors.push({ code: 'LOCATION_CHANGED', message: '台账对象已变化，请重新校验' });
    }
    if (errors.length) gridErrors.push({ sheetName: row.sheetName, rowNumber: row.rowNumber, errors });
  }
  if (gridErrors.length) return c.json(apiError('IMPORT_GRID_CHANGED', '台账已变化，请先维护基础台账并重新校验导入', gridErrors), 422);
  const sourceKeys = rows.map((row) => row.sourceKey);
  const existingBySource = new Map((await publishRepository.findDemandIdsBySourceKeys(sourceKeys)).map((item) => [item.sourceKey, item.demandId]));
  const signatures = rows
    .map((row) => parseJson<NormalizedImportRow | null>(row.normalizedJson, null)?.businessSignature ?? null)
    .filter((value): value is string => Boolean(value));
  const existingBySignature = new Map((await publishRepository.findImportDemandIdsBySignatures(batch.id, signatures)).map((item) => [item.businessSignature, item.demandId]));

  const publishedRows = batch.publishedRows + rows.length;
  const done = publishedRows >= batch.validRows;
  const nextStatus: ImportBatchSummary['status'] = done ? 'published' : 'publishing';
  const data: ImportPublishResult = { processed: rows.length, publishedRows, done, version: expectedVersion + 1 };
  const response = { ok: true as const, data };
  const publishRows = [];
  for (const row of rows) {
    const normalized = parseJson<NormalizedImportRow | null>(row.normalizedJson, null);
    if (!normalized || !normalized.businessSignature) {
      return c.json(apiError('IMPORT_ROW_NOT_VALIDATED', '存在缺少规范化结果的行'), 409);
    }
    const existingId = existingBySource.get(row.sourceKey) ?? existingBySignature.get(normalized.businessSignature);
    const demandId = existingId ?? crypto.randomUUID();
    if (!existingId) existingBySignature.set(normalized.businessSignature, demandId);
    publishRows.push({
      rowId: row.id,
      demandId,
      createDemand: !existingId,
      sourceRowId: crypto.randomUUID(),
      materialRowId: crypto.randomUUID(),
      sourceKey: row.sourceKey,
      sheetName: row.sheetName,
      rowNumber: row.rowNumber,
      rawJson: row.rawJson,
      normalized,
    });
  }
  try {
    await publishRepository.commitPublish({
      batchId: batch.id,
      expectedVersion,
      actorId: actor.id,
      now,
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
      fileName: batch.fileName,
      fileSha256: batch.fileSha256,
      nextStatus,
      publishedRows,
      publishedAt: done ? now : null,
      auditId: crypto.randomUUID(),
      beforePublishedRows: batch.publishedRows,
      rows: publishRows,
    });
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    const current = await importRepository.findById(batch.id);
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
  const { database } = createCloudflarePersistence(c.env);
  const page = await new SqlDemandQueryRepository(database).list({ query, cursor, limit });
  return c.json({
    ok: true as const,
    data: {
      items: page.items,
      nextCursor: page.nextCursor ? makeCursor(page.nextCursor.createdAt, page.nextCursor.id) : null,
    },
  });
});

p2App.get('/demands/:id', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  const data = await new SqlDemandQueryRepository(database).getById(c.req.param('id'));
  if (!data) return c.json(apiError('DEMAND_NOT_FOUND', '需求不存在'), 404);
  return c.json({ ok: true as const, data });
});
