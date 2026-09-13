import { Hono, type Context } from 'hono';
import type { ApiError, LifecycleState } from '@tpm/shared';
import { hasScope, requireRoles, type AppEnv } from './auth';

const MAX_ITEMS = 100;

type ProjectRow = {
  id: string;
  name: string;
  business_year: number | null;
  owner: string | null;
  status: 'draft' | 'confirmed';
  reserve_version: number;
  framework_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type ProjectMaterialRow = {
  id: string;
  project_id: string;
  material_id: string | null;
  model: string;
  unit: string;
  required_quantity_scaled: number;
  unit_price_scaled: number | null;
  amount_fen: number | null;
  reserve_category_id: string | null;
  reserve_category_key: string | null;
  reserve_category_label: string | null;
  active: number;
  version: number;
  created_at: string;
  updated_at: string;
};

type ProjectTaskRow = {
  id: string;
  project_id: string;
  project_release_id: string;
  name: string;
  description: string | null;
  scope_text: string | null;
  owner: string | null;
  planned_date: string | null;
  planned_quantity_scaled: number;
  unit: string;
  version: number;
  implementation_version: number;
  settlement_version: number;
  created_at: string;
  updated_at: string;
};

type TaskDemandScopeRow = {
  id: string;
  task_id: string;
  demand_id: string;
  planned_quantity_scaled: number;
  sequence_no: string;
  line_name: string;
  section_text: string;
};

type TaskMaterialRow = {
  id: string;
  task_id: string;
  project_material_requirement_id: string | null;
  material_id: string | null;
  model: string;
  unit: string;
  required_quantity_scaled: number;
  supply_version: number;
  created_at: string;
  updated_at: string;
};

function apiError(code: string, message: string, details?: unknown): ApiError {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function cleanText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function nullableText(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const text = cleanText(value);
  return text && text.length <= max ? text : undefined;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function expectedVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function validYear(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const year = Number(value);
  return Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : undefined;
}

function validDate(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const date = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : undefined;
}

function parseQuantityScaled(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  const raw = cleanText(value);
  const match = raw.match(/^(\d+)(?:\.(\d{1,4}))?$/);
  if (!match) return null;
  const scaled = Number(match[1]) * 10000 + Number((match[2] ?? '').padEnd(4, '0'));
  return Number.isSafeInteger(scaled) && scaled > 0 ? scaled : null;
}

function validVoltage(value: unknown): { raw: string; verified: string | null } | null {
  const raw = cleanText(value);
  if (!raw || raw.length > 40) return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*[kK][vV]$/);
  return { raw, verified: match ? `${match[1]}kV` : null };
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function lifecycleState(implemented: boolean, settled: boolean): LifecycleState {
  if (implemented && settled) return 'implemented_settled';
  if (implemented) return 'implemented_unsettled';
  if (settled) return 'unimplemented_settled';
  return 'unimplemented_unsettled';
}

function requireIdempotencyKey(c: Context<AppEnv>): string | Response {
  const key = c.req.header('Idempotency-Key')?.trim();
  if (!key || key.length > 200) return c.json(apiError('IDEMPOTENCY_KEY_REQUIRED', '变更请求必须提供有效的 Idempotency-Key'), 400);
  return key;
}

async function requestHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function replayIdempotentResponse(c: Context<AppEnv>, key: string, operation: string, hash: string) {
  const actor = c.get('currentUser');
  const row = await c.env.DB.prepare(
    `SELECT actor_member_id,operation,request_hash,response_json,status_code FROM idempotency_records WHERE idempotency_key=? LIMIT 1`,
  ).bind(key).first<{ actor_member_id: string; operation: string; request_hash: string; response_json: string; status_code: number }>();
  if (!row) return null;
  if (row.actor_member_id !== actor.id || row.operation !== operation || row.request_hash !== hash) {
    return c.json(apiError('IDEMPOTENCY_CONFLICT', '该 Idempotency-Key 已用于不同请求'), 409);
  }
  return new Response(row.response_json, {
    status: row.status_code,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' },
  });
}

function idempotencyStatement(db: D1Database, key: string, actorId: string, operation: string, hash: string, response: unknown, statusCode: number, now: string) {
  return db.prepare(
    `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(key, actorId, operation, hash, JSON.stringify(response), statusCode, now);
}

function auditStatement(db: D1Database, actorId: string, action: string, objectType: string, objectId: string, before: unknown, after: unknown, now: string) {
  return db.prepare(
    `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(
    crypto.randomUUID(), actorId, action, objectType, objectId,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    now,
  );
}

function projectVersionGuard(db: D1Database, projectId: string, version: number, now: string, status?: 'draft' | 'confirmed', incrementReserve = false) {
  return db.prepare(
    `UPDATE projects
     SET version=version+1,
         status=COALESCE(?,status),
         reserve_version=reserve_version+?,
         updated_at=CASE WHEN version=? THEN ? ELSE NULL END
     WHERE id=?`,
  ).bind(status ?? null, incrementReserve ? 1 : 0, version, now, projectId);
}

function taskImplementationVersionGuard(db: D1Database, taskId: string, version: number, now: string) {
  return db.prepare(
    `UPDATE project_tasks
     SET implementation_version=implementation_version+1,
         updated_at=CASE WHEN implementation_version=? THEN ? ELSE NULL END
     WHERE id=?`,
  ).bind(version, now, taskId);
}

function taskSettlementVersionGuard(db: D1Database, taskId: string, version: number, now: string) {
  return db.prepare(
    `UPDATE project_tasks
     SET settlement_version=settlement_version+1,
         updated_at=CASE WHEN settlement_version=? THEN ? ELSE NULL END
     WHERE id=?`,
  ).bind(version, now, taskId);
}

function supplyVersionGuard(db: D1Database, taskMaterialId: string, version: number, now: string) {
  return db.prepare(
    `UPDATE task_material_requirements
     SET supply_version=supply_version+1,
         updated_at=CASE WHEN supply_version=? THEN ? ELSE NULL END
     WHERE id=?`,
  ).bind(version, now, taskMaterialId);
}

async function findProject(db: D1Database, id: string) {
  return db.prepare(
    `SELECT id,name,business_year,owner,status,reserve_version,framework_id,version,created_at,updated_at
     FROM projects WHERE id=? LIMIT 1`,
  ).bind(id).first<ProjectRow>();
}

async function canProject(c: Context<AppEnv>, projectId: string) {
  const user = c.get('currentUser');
  if (user.role === 'admin' || hasScope(user.scopes, 'project', projectId) || user.scopes.some((scope) => scope.type === 'all')) return true;
  const project = await findProject(c.env.DB, projectId);
  return Boolean(project?.framework_id && hasScope(user.scopes, 'framework', project.framework_id));
}

function calculateAmountFen(quantityScaled: number, unitPriceScaled: number | null): number | null {
  if (unitPriceScaled === null) return null;
  const numerator = BigInt(quantityScaled) * BigInt(unitPriceScaled);
  const roundedFen = (numerator + 500000n) / 1000000n;
  return roundedFen <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(roundedFen) : null;
}

function projectMaterialSummary(row: ProjectMaterialRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    materialId: row.material_id,
    model: row.model,
    unit: row.unit,
    requiredQuantityScaled: row.required_quantity_scaled,
    unitPriceScaled: row.unit_price_scaled,
    amountFen: row.amount_fen,
    reserveCategoryId: row.reserve_category_id,
    reserveCategory: row.reserve_category_id && row.reserve_category_key && row.reserve_category_label
      ? { id: row.reserve_category_id, key: row.reserve_category_key, label: row.reserve_category_label }
      : null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadProjectMaterials(db: D1Database, projectId: string) {
  const result = await db.prepare(
    `SELECT pmr.id,pmr.project_id,pmr.material_id,pmr.model,pmr.unit,pmr.required_quantity_scaled,
            pmr.unit_price_scaled,pmr.amount_fen,pmr.reserve_category_id,pmr.active,pmr.version,pmr.created_at,pmr.updated_at,
            rc.category_key AS reserve_category_key,rc.label AS reserve_category_label
     FROM project_material_requirements pmr
     LEFT JOIN reserve_categories rc ON rc.id=pmr.reserve_category_id
     WHERE pmr.project_id=? AND pmr.active=1 ORDER BY pmr.created_at,pmr.id`,
  ).bind(projectId).all<ProjectMaterialRow>();
  return result.results ?? [];
}

async function loadProjectDemandLinks(db: D1Database, projectId: string) {
  const result = await db.prepare(
    `SELECT pdl.id,pdl.demand_id,d.sequence_no,d.business_year,d.voltage_raw,d.voltage_verified,d.line_name,d.section_text,d.category_key,d.owner,pdl.created_at
     FROM project_demand_links pdl INNER JOIN demands d ON d.id=pdl.demand_id
     WHERE pdl.project_id=? ORDER BY d.sequence_no COLLATE NOCASE,pdl.id`,
  ).bind(projectId).all<{
    id: string; demand_id: string; sequence_no: string; business_year: number | null; voltage_raw: string; voltage_verified: string | null;
    line_name: string; section_text: string; category_key: string | null; owner: string | null; created_at: string;
  }>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    demandId: row.demand_id,
    sequenceNo: row.sequence_no,
    year: row.business_year,
    voltage: row.voltage_verified ?? row.voltage_raw,
    lineName: row.line_name,
    section: row.section_text,
    category: row.category_key,
    owner: row.owner,
    createdAt: row.created_at,
  }));
}

async function fetchReserveProject(db: D1Database, projectId: string) {
  const project = await findProject(db, projectId);
  if (!project) return null;
  const [demandLinks, materialRows] = await Promise.all([
    loadProjectDemandLinks(db, projectId),
    loadProjectMaterials(db, projectId),
  ]);
  const materialRequirements = materialRows.map(projectMaterialSummary);
  let knownMaterialAmountFen = 0;
  let missingPriceCount = 0;
  for (const item of materialRows) {
    if (item.amount_fen === null) missingPriceCount += 1;
    else knownMaterialAmountFen += item.amount_fen;
  }
  return {
    id: project.id,
    name: project.name,
    year: project.business_year,
    owner: project.owner,
    status: project.status,
    reserveVersion: project.reserve_version,
    frameworkId: project.framework_id,
    version: project.version,
    demandLinks,
    materialRequirements,
    knownMaterialAmountFen,
    missingPriceCount,
    materialPriceCompletenessBasisPoints: materialRows.length === 0 ? 10000 : Math.floor(((materialRows.length - missingPriceCount) * 10000) / materialRows.length),
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

async function loadDemandDetail(db: D1Database, demandId: string) {
  const row = await db.prepare(
    `SELECT id,source_type,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,
            sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,raw_json,version,created_at,updated_at
     FROM demands WHERE id=? LIMIT 1`,
  ).bind(demandId).first<{
    id: string; source_type: 'manual' | 'import'; source_batch_id: string | null; source_file_sha256: string | null; source_file_name: string | null;
    source_sheet: string | null; source_row_number: number | null; sequence_no: string; business_year: number | null; voltage_raw: string;
    voltage_verified: string | null; line_name: string; section_text: string; category_key: string | null; owner: string | null;
    raw_json: string; version: number; created_at: string; updated_at: string;
  }>();
  if (!row) return null;
  const materials = await db.prepare(
    `SELECT dm.id,dm.raw_model,dm.quantity_scaled,dm.unit,dm.material_id,dm.version,
            m.code AS material_code,m.name AS material_name,m.model AS material_model,m.unit AS material_unit,m.enabled AS material_enabled,m.version AS material_version
     FROM demand_materials dm LEFT JOIN materials m ON m.id=dm.material_id
     WHERE dm.demand_id=? ORDER BY dm.created_at,dm.id`,
  ).bind(demandId).all<{
    id: string; raw_model: string; quantity_scaled: number; unit: string | null; material_id: string | null; version: number;
    material_code: string | null; material_name: string | null; material_model: string | null; material_unit: string | null; material_enabled: number | null; material_version: number | null;
  }>();
  const sourceRows = row.source_type === 'import'
    ? await db.prepare(
      `SELECT file_name,file_sha256,sheet_name,source_row_number,raw_json FROM demand_source_rows WHERE demand_id=? ORDER BY source_row_number,id`,
    ).bind(demandId).all<{ file_name: string; file_sha256: string; sheet_name: string; source_row_number: number; raw_json: string }>()
    : null;
  return {
    id: row.id,
    sequenceNo: row.sequence_no,
    year: row.business_year,
    voltageRaw: row.voltage_raw,
    voltageVerified: row.voltage_verified,
    lineName: row.line_name,
    section: row.section_text,
    category: row.category_key,
    owner: row.owner,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: row.source_type === 'manual'
      ? { type: 'manual' as const, raw: JSON.parse(row.raw_json) as Record<string, unknown> }
      : {
          type: 'import' as const,
          batchId: row.source_batch_id!,
          fileName: row.source_file_name!,
          fileSha256: row.source_file_sha256!,
          sheetName: row.source_sheet!,
          rowNumber: row.source_row_number!,
          raw: JSON.parse(row.raw_json) as Record<string, unknown>,
          rows: (sourceRows?.results ?? []).map((source) => ({
            fileName: source.file_name,
            fileSha256: source.file_sha256,
            sheetName: source.sheet_name,
            rowNumber: source.source_row_number,
            raw: JSON.parse(source.raw_json) as Record<string, unknown>,
          })),
        },
    materials: (materials.results ?? []).map((item) => ({
      id: item.id,
      rawModel: item.raw_model,
      quantityScaled: item.quantity_scaled,
      unit: item.unit,
      version: item.version,
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
    })),
  };
}

function normalizeDemandMaterials(body: Record<string, unknown>): Array<{ rawModel: string; materialId: string | null; quantityScaled: number; unit: string | null }> | null {
  const source = Array.isArray(body.materials)
    ? body.materials
    : body.materialModel !== undefined || body.materialQuantity !== undefined
      ? [{ rawModel: body.materialModel, materialId: null, quantityScaled: parseQuantityScaled(body.materialQuantity), unit: body.unit }]
      : [];
  if (source.length > MAX_ITEMS) return null;
  const items: Array<{ rawModel: string; materialId: string | null; quantityScaled: number; unit: string | null }> = [];
  for (const raw of source) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const rawModel = cleanText(item.rawModel ?? item.materialModel);
    const materialId = item.materialId === null || item.materialId === undefined ? null : cleanText(item.materialId);
    const quantityScaled = positiveInteger(item.quantityScaled) ?? parseQuantityScaled(item.materialQuantity);
    const unit = item.unit === null || item.unit === undefined || item.unit === '' ? null : cleanText(item.unit);
    if (!rawModel || rawModel.length > 160 || quantityScaled === null || (materialId !== null && !materialId) || (unit !== null && unit.length > 40)) return null;
    items.push({ rawModel, materialId, quantityScaled, unit });
  }
  return items;
}

async function normalizeProjectMaterials(db: D1Database, value: unknown, allowIds: boolean) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  const out: Array<{
    id: string | null;
    materialId: string | null;
    model: string;
    unit: string;
    requiredQuantityScaled: number;
    unitPriceScaled: number | null;
    amountFen: number | null;
    reserveCategoryId: string | null;
  }> = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const id = item.id === null || item.id === undefined ? null : cleanText(item.id);
    const materialId = item.materialId === null || item.materialId === undefined ? null : cleanText(item.materialId);
    let model = cleanText(item.model);
    let unit = cleanText(item.unit);
    const quantity = positiveInteger(item.requiredQuantityScaled);
    const unitPrice = item.unitPriceScaled === null || item.unitPriceScaled === undefined ? null : nonNegativeInteger(item.unitPriceScaled);
    const categoryId = item.reserveCategoryId === null || item.reserveCategoryId === undefined ? null : cleanText(item.reserveCategoryId);
    if ((!allowIds && id !== null) || (id !== null && (!id || ids.has(id))) || quantity === null || unitPrice === null && item.unitPriceScaled !== null && item.unitPriceScaled !== undefined) return null;
    if (id) ids.add(id);
    if (materialId) {
      const material = await db.prepare(`SELECT id,model,unit,enabled FROM materials WHERE id=? LIMIT 1`).bind(materialId).first<{ id: string; model: string; unit: string; enabled: number }>();
      if (!material || material.enabled !== 1) return null;
      if (!model) model = material.model;
      if (!unit) unit = material.unit;
    }
    if (!model || model.length > 160 || !unit || unit.length > 40) return null;
    if (categoryId) {
      const category = await db.prepare(`SELECT id FROM reserve_categories WHERE id=? AND enabled=1 LIMIT 1`).bind(categoryId).first<{ id: string }>();
      if (!category) return null;
    }
    const amountFen = calculateAmountFen(quantity, unitPrice);
    if (unitPrice !== null && amountFen === null) return null;
    out.push({ id, materialId, model, unit, requiredQuantityScaled: quantity, unitPriceScaled: unitPrice, amountFen, reserveCategoryId: categoryId });
  }
  return out;
}

async function normalizeDemandIds(db: D1Database, value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const id = cleanText(raw);
    if (!id || seen.has(id)) return null;
    const demand = await db.prepare(`SELECT id FROM demands WHERE id=? LIMIT 1`).bind(id).first<{ id: string }>();
    if (!demand) return null;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function findTask(db: D1Database, id: string) {
  return db.prepare(
    `SELECT id,project_id,project_release_id,name,description,scope_text,owner,planned_date,planned_quantity_scaled,unit,version,implementation_version,settlement_version,created_at,updated_at
     FROM project_tasks WHERE id=? LIMIT 1`,
  ).bind(id).first<ProjectTaskRow>();
}

async function loadTaskDemandScopes(db: D1Database, taskId: string) {
  const result = await db.prepare(
    `SELECT tds.id,tds.task_id,tds.demand_id,tds.planned_quantity_scaled,d.sequence_no,d.line_name,d.section_text
     FROM task_demand_scopes tds INNER JOIN demands d ON d.id=tds.demand_id
     WHERE tds.task_id=? ORDER BY tds.id`,
  ).bind(taskId).all<TaskDemandScopeRow>();
  return result.results ?? [];
}

async function loadTaskMaterials(db: D1Database, taskId: string) {
  const result = await db.prepare(
    `SELECT id,task_id,project_material_requirement_id,material_id,model,unit,required_quantity_scaled,supply_version,created_at,updated_at
     FROM task_material_requirements WHERE task_id=? ORDER BY id`,
  ).bind(taskId).all<TaskMaterialRow>();
  return result.results ?? [];
}

async function supplyTotals(db: D1Database, taskMaterialId: string) {
  const row = await db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN stage='reported' THEN quantity_scaled ELSE 0 END),0) AS reported,
       COALESCE(SUM(CASE WHEN stage='shipped' THEN quantity_scaled ELSE 0 END),0) AS shipped,
       COALESCE(SUM(CASE WHEN stage='arrived' THEN quantity_scaled ELSE 0 END),0) AS arrived
     FROM material_supply_events WHERE task_material_requirement_id=?`,
  ).bind(taskMaterialId).first<{ reported: number; shipped: number; arrived: number }>();
  return {
    reportedQuantityScaled: Number(row?.reported ?? 0),
    shippedQuantityScaled: Number(row?.shipped ?? 0),
    arrivedQuantityScaled: Number(row?.arrived ?? 0),
  };
}

async function taskExecutionSummary(db: D1Database, task: ProjectTaskRow) {
  const [scopes, materials, implementation, settlement, finalSettlement, reminder] = await Promise.all([
    loadTaskDemandScopes(db, task.id),
    loadTaskMaterials(db, task.id),
    db.prepare(`SELECT COALESCE(SUM(completed_quantity_scaled),0) AS total FROM task_implementation_records WHERE task_id=?`).bind(task.id).first<{ total: number }>(),
    db.prepare(`SELECT COALESCE(SUM(coverage_quantity_scaled),0) AS total FROM task_settlements WHERE task_id=? AND voided_at IS NULL`).bind(task.id).first<{ total: number }>(),
    db.prepare(`SELECT id FROM task_settlements WHERE task_id=? AND final=1 AND voided_at IS NULL ORDER BY settlement_date DESC,created_at DESC LIMIT 1`).bind(task.id).first<{ id: string }>(),
    db.prepare(`SELECT first_implementation_date,due_date,status,final_settlement_id FROM task_settlement_reminders WHERE task_id=? LIMIT 1`).bind(task.id).first<{ first_implementation_date: string; due_date: string; status: 'open' | 'closed'; final_settlement_id: string | null }>(),
  ]);
  const implementedQuantityScaled = Number(implementation?.total ?? 0);
  const settledQuantityScaled = Number(settlement?.total ?? 0);
  const implementationComplete = implementedQuantityScaled >= task.planned_quantity_scaled;
  const settlementComplete = settledQuantityScaled >= task.planned_quantity_scaled && Boolean(finalSettlement);
  const materialSummaries = [];
  for (const material of materials) {
    materialSummaries.push({
      id: material.id,
      taskId: material.task_id,
      projectMaterialRequirementId: material.project_material_requirement_id,
      materialId: material.material_id,
      model: material.model,
      unit: material.unit,
      requiredQuantityScaled: material.required_quantity_scaled,
      supplyVersion: material.supply_version,
      totals: await supplyTotals(db, material.id),
      createdAt: material.created_at,
      updatedAt: material.updated_at,
    });
  }
  return {
    id: task.id,
    projectId: task.project_id,
    projectReleaseId: task.project_release_id,
    name: task.name,
    description: task.description,
    scopeText: task.scope_text,
    owner: task.owner,
    plannedDate: task.planned_date,
    plannedQuantityScaled: task.planned_quantity_scaled,
    unit: task.unit,
    version: task.version,
    implementationVersion: task.implementation_version,
    settlementVersion: task.settlement_version,
    demandScopes: scopes.map((scope) => ({
      id: scope.id,
      taskId: scope.task_id,
      demandId: scope.demand_id,
      plannedQuantityScaled: scope.planned_quantity_scaled,
      demand: { sequenceNo: scope.sequence_no, lineName: scope.line_name, section: scope.section_text },
    })),
    materials: materialSummaries.map(({ totals: _totals, ...material }) => material),
    supplyTotals: materialSummaries.map((material) => ({ taskMaterialRequirementId: material.id, model: material.model, unit: material.unit, totals: material.totals })),
    implementedQuantityScaled,
    settledQuantityScaled,
    implementationComplete,
    settlementComplete,
    state: lifecycleState(implementationComplete, settlementComplete),
    settlementReminder: reminder
      ? {
          needed: reminder.status === 'open',
          firstImplementationDate: reminder.first_implementation_date,
          dueDate: reminder.due_date,
          finalSettlementId: reminder.final_settlement_id,
        }
      : { needed: false, firstImplementationDate: null, dueDate: null, finalSettlementId: finalSettlement?.id ?? null },
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

async function demandExecutionSummary(db: D1Database, demandId: string) {
  const demand = await db.prepare(`SELECT id,sequence_no,line_name,section_text FROM demands WHERE id=? LIMIT 1`).bind(demandId).first<{ id: string; sequence_no: string; line_name: string; section_text: string }>();
  if (!demand) return null;
  const planned = await db.prepare(`SELECT COALESCE(SUM(planned_quantity_scaled),0) AS total FROM task_demand_scopes WHERE demand_id=?`).bind(demandId).first<{ total: number }>();
  const implemented = await db.prepare(
    `SELECT COALESCE(SUM(til.completed_quantity_scaled),0) AS total
     FROM task_implementation_scope_lines til INNER JOIN task_demand_scopes tds ON tds.id=til.task_demand_scope_id
     WHERE tds.demand_id=?`,
  ).bind(demandId).first<{ total: number }>();
  const settled = await db.prepare(
    `SELECT COALESCE(SUM(tsl.quantity_scaled),0) AS total
     FROM task_settlement_scope_lines tsl
     INNER JOIN task_demand_scopes tds ON tds.id=tsl.task_demand_scope_id
     INNER JOIN task_settlements ts ON ts.id=tsl.settlement_id
     WHERE tds.demand_id=? AND ts.voided_at IS NULL`,
  ).bind(demandId).first<{ total: number }>();
  const taskCount = await db.prepare(`SELECT COUNT(DISTINCT task_id) AS count FROM task_demand_scopes WHERE demand_id=?`).bind(demandId).first<{ count: number }>();
  const tasksWithoutFinal = await db.prepare(
    `SELECT COUNT(DISTINCT tds.task_id) AS count
     FROM task_demand_scopes tds
     WHERE tds.demand_id=? AND NOT EXISTS (
       SELECT 1 FROM task_settlements ts WHERE ts.task_id=tds.task_id AND ts.final=1 AND ts.voided_at IS NULL
     )`,
  ).bind(demandId).first<{ count: number }>();
  const plannedQuantityScaled = Number(planned?.total ?? 0);
  const implementedQuantityScaled = Number(implemented?.total ?? 0);
  const settledQuantityScaled = Number(settled?.total ?? 0);
  const hasTasks = Number(taskCount?.count ?? 0) > 0;
  const implementationComplete = hasTasks && implementedQuantityScaled >= plannedQuantityScaled;
  const settlementComplete = hasTasks && settledQuantityScaled >= plannedQuantityScaled && Number(tasksWithoutFinal?.count ?? 0) === 0;
  return {
    demandId,
    sequenceNo: demand.sequence_no,
    lineName: demand.line_name,
    section: demand.section_text,
    plannedQuantityScaled,
    implementedQuantityScaled,
    settledQuantityScaled,
    implementationProgressBasisPoints: plannedQuantityScaled > 0 ? Math.min(10000, Math.floor((implementedQuantityScaled * 10000) / plannedQuantityScaled)) : 0,
    settlementProgressBasisPoints: plannedQuantityScaled > 0 ? Math.min(10000, Math.floor((settledQuantityScaled * 10000) / plannedQuantityScaled)) : 0,
    implementationComplete,
    settlementComplete,
    state: lifecycleState(implementationComplete, settlementComplete),
  };
}

export const p8App = new Hono<AppEnv>();

p8App.post('/demands', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const sequenceNo = cleanText(body.sequenceNo), voltage = validVoltage(body.voltage), lineName = cleanText(body.lineName), section = cleanText(body.section);
  const year = validYear(body.year), category = nullableText(body.category, 120), owner = nullableText(body.owner, 80), materials = normalizeDemandMaterials(body);
  if (!sequenceNo || sequenceNo.length > 120 || !voltage || !lineName || lineName.length > 200 || !section || section.length > 200 || year === undefined || category === undefined || owner === undefined || !materials) {
    return c.json(apiError('INVALID_DEMAND', '需求字段或需求物资子明细无效'), 422);
  }
  for (const item of materials) {
    if (item.materialId) {
      const material = await c.env.DB.prepare(`SELECT id FROM materials WHERE id=? AND enabled=1 LIMIT 1`).bind(item.materialId).first<{ id: string }>();
      if (!material) return c.json(apiError('MATERIAL_NOT_FOUND', '需求物资引用的标准物资不存在或已停用'), 422);
    }
  }
  const request = { sequenceNo, year, voltage: voltage.raw, lineName, section, category, owner, materials };
  const hash = await requestHash(request), operation = 'demands.create.abstract';
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), id = crypto.randomUUID(), now = new Date().toISOString();
  const sourceKey = `manual:${id}`;
  const businessSignature = await requestHash({ sequenceNo, year, voltage: voltage.verified ?? voltage.raw, lineName, section, category });
  const raw = { sequenceNo, year, voltage: voltage.raw, lineName, section, category, owner, materials };
  const materialRows = materials.map((item) => ({ id: crypto.randomUUID(), item }));
  const data = {
    id, sequenceNo, year, voltageRaw: voltage.raw, voltageVerified: voltage.verified, lineName, section, category, owner,
    version: 1, createdAt: now, updatedAt: now, source: { type: 'manual' as const, raw },
    materials: materialRows.map(({ id: materialId, item }) => ({ id: materialId, rawModel: item.rawModel, quantityScaled: item.quantityScaled, unit: item.unit, material: null, version: 1 })),
  };
  const response = { ok: true as const, data };
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO demands
         (id,source_type,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,
          sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,raw_json,extra_json,version,created_by,created_at,updated_at)
         VALUES (?,'manual',?,NULL,NULL,NULL,NULL,NULL,?,?,?,?,?,?,?,?,?,?,'{}',1,?,?,?)`,
      ).bind(id, sourceKey, sequenceNo, year, voltage.raw, voltage.verified, lineName, section, category, owner, businessSignature, JSON.stringify(raw), actor.id, now, now),
      ...materialRows.map(({ id: materialId, item }) => c.env.DB.prepare(
        `INSERT INTO demand_materials (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at,source_import_row_id,created_by,version)
         VALUES (?,?,?,?,?,?,?,NULL,?,1)`,
      ).bind(materialId, id, item.rawModel, item.materialId, item.quantityScaled, item.unit, now, actor.id)),
      auditStatement(c.env.DB, actor.id, 'demand.create.abstract', 'demand', id, null, data, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 201, now),
    ]);
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    return c.json(apiError('DEMAND_CREATE_CONFLICT', '需求创建发生冲突，请刷新后重试'), 409);
  }
  return c.json(response, 201);
});

p8App.post('/demands/:id/materials', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion), materials = normalizeDemandMaterials(body);
  if (version === null || !materials || materials.length < 1) return c.json(apiError('INVALID_DEMAND_MATERIALS', 'expectedVersion 或需求物资子明细无效'), 422);
  const demandId = c.req.param('id');
  const current = await c.env.DB.prepare(`SELECT id,version FROM demands WHERE id=? LIMIT 1`).bind(demandId).first<{ id: string; version: number }>();
  if (!current) return c.json(apiError('DEMAND_NOT_FOUND', '需求不存在'), 404);
  if (current.version !== version) return c.json(apiError('VERSION_CONFLICT', '需求已被修改，请刷新后重试'), 409);
  for (const item of materials) {
    if (item.materialId) {
      const material = await c.env.DB.prepare(`SELECT id FROM materials WHERE id=? AND enabled=1 LIMIT 1`).bind(item.materialId).first<{ id: string }>();
      if (!material) return c.json(apiError('MATERIAL_NOT_FOUND', '需求物资引用的标准物资不存在或已停用'), 422);
    }
  }
  const request = { expectedVersion: version, materials }, hash = await requestHash(request), operation = `demands.materials.add:${demandId}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), now = new Date().toISOString();
  const rows = materials.map((item) => ({ id: crypto.randomUUID(), item }));
  const responseData = await loadDemandDetail(c.env.DB, demandId);
  const data = {
    ...responseData!,
    version: version + 1,
    updatedAt: now,
    materials: [...responseData!.materials, ...rows.map(({ id, item }) => ({ id, rawModel: item.rawModel, quantityScaled: item.quantityScaled, unit: item.unit, material: null, version: 1 }))],
  };
  const response = { ok: true as const, data };
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE demands SET version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END WHERE id=?`).bind(version, now, demandId),
      ...rows.map(({ id, item }) => c.env.DB.prepare(
        `INSERT INTO demand_materials (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at,source_import_row_id,created_by,version)
         VALUES (?,?,?,?,?,?,?,NULL,?,1)`,
      ).bind(id, demandId, item.rawModel, item.materialId, item.quantityScaled, item.unit, now, actor.id)),
      auditStatement(c.env.DB, actor.id, 'demand.materials.add', 'demand', demandId, { version }, { version: version + 1, added: rows.length }, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, now),
    ]);
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    const latest = await c.env.DB.prepare(`SELECT version FROM demands WHERE id=? LIMIT 1`).bind(demandId).first<{ version: number }>();
    if (latest && latest.version !== version) return c.json(apiError('VERSION_CONFLICT', '需求已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('DEMAND_MATERIAL_CONFLICT', '需求物资写入发生冲突'), 409);
  }
  return c.json(response);
});

p8App.post('/reserve-projects', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const name = cleanText(body.name), year = validYear(body.year), owner = nullableText(body.owner, 80);
  const demandIds = await normalizeDemandIds(c.env.DB, body.demandIds ?? []), materials = await normalizeProjectMaterials(c.env.DB, body.materials ?? [], false);
  if (!name || name.length > 160 || year === undefined || owner === undefined || !demandIds || !materials) return c.json(apiError('INVALID_PROJECT', '项目名称、年度、需求关联或项目物资无效'), 422);
  const actor = c.get('currentUser');
  if (actor.role !== 'admin' && !actor.scopes.some((scope) => scope.type === 'all')) return c.json(apiError('SCOPE_FORBIDDEN', '当前成员没有创建新项目的全局范围'), 403);
  const request = { name, year, owner, demandIds, materials }, hash = await requestHash(request), operation = 'reserve-projects.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const id = crypto.randomUUID(), now = new Date().toISOString();
  const materialRows = materials.map((item) => ({ id: crypto.randomUUID(), item }));
  const response = { ok: true as const, data: {
    id, name, year, owner, status: 'draft' as const, reserveVersion: 0, frameworkId: null, version: 1,
    demandLinks: demandIds.map((demandId) => ({ id: '', demandId })),
    materialRequirements: materialRows.map(({ id: materialId, item }) => ({
      id: materialId,
      projectId: id,
      materialId: item.materialId,
      model: item.model,
      unit: item.unit,
      requiredQuantityScaled: item.requiredQuantityScaled,
      unitPriceScaled: item.unitPriceScaled,
      amountFen: item.amountFen,
      reserveCategoryId: item.reserveCategoryId,
      reserveCategory: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),

    knownMaterialAmountFen: materialRows.reduce((sum, row) => sum + (row.item.amountFen ?? 0), 0),
    missingPriceCount: materialRows.filter((row) => row.item.amountFen === null).length,
    materialPriceCompletenessBasisPoints: materialRows.length === 0 ? 10000 : Math.floor((materialRows.filter((row) => row.item.amountFen !== null).length * 10000) / materialRows.length),
    createdAt: now, updatedAt: now,
  } };
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO projects (id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at) VALUES (?,?,?,?,'draft',0,NULL,1,?,?,?)`).bind(id, name, year, owner, actor.id, now, now),
      ...demandIds.map((demandId) => c.env.DB.prepare(`INSERT INTO project_demand_links (id,project_id,demand_id,created_by,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), id, demandId, actor.id, now)),
      ...materialRows.map(({ id: materialId, item }) => c.env.DB.prepare(
        `INSERT INTO project_material_requirements
         (id,project_id,material_id,model,unit,required_quantity_scaled,unit_price_scaled,amount_fen,reserve_category_id,active,version,created_by,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?,?)`,
      ).bind(materialId, id, item.materialId, item.model, item.unit, item.requiredQuantityScaled, item.unitPriceScaled, item.amountFen, item.reserveCategoryId, actor.id, now, now)),
      auditStatement(c.env.DB, actor.id, 'reserve_project.create', 'project', id, null, request, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 201, now),
    ]);
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    return c.json(apiError('PROJECT_CREATE_CONFLICT', '储备项目创建发生冲突'), 409);
  }
  const actual = await fetchReserveProject(c.env.DB, id);
  return c.json({ ok: true as const, data: actual! }, 201);
});

p8App.get('/reserve-projects', async (c) => {
  const user = c.get('currentUser');
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? '50')));
  const rows = await c.env.DB.prepare(
    `SELECT id,name,business_year,owner,status,reserve_version,framework_id,version,created_at,updated_at FROM projects ORDER BY created_at DESC,id DESC LIMIT ?`,
  ).bind(limit).all<ProjectRow>();
  const items = [];
  for (const row of rows.results ?? []) {
    if (user.role === 'admin' || user.scopes.some((scope) => scope.type === 'all') || hasScope(user.scopes, 'project', row.id) || (row.framework_id && hasScope(user.scopes, 'framework', row.framework_id))) {
      items.push(await fetchReserveProject(c.env.DB, row.id));
    }
  }
  return c.json({ ok: true as const, data: { items: items.filter(Boolean), nextCursor: null } });
});

p8App.get('/reserve-projects/:id', async (c) => {
  const project = await findProject(c.env.DB, c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!await canProject(c, project.id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目'), 403);
  return c.json({ ok: true as const, data: (await fetchReserveProject(c.env.DB, project.id))! });
});

p8App.put('/reserve-projects/:id/demands', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion), demandIds = await normalizeDemandIds(c.env.DB, body.demandIds);
  if (version === null || !demandIds) return c.json(apiError('INVALID_PROJECT_DEMANDS', 'expectedVersion 或需求关联无效'), 422);
  const project = await findProject(c.env.DB, c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!await canProject(c, project.id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权修改该项目'), 403);
  if (project.version !== version) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const currentLinks = await loadProjectDemandLinks(c.env.DB, project.id);
  const nextSet = new Set(demandIds);
  for (const link of currentLinks) {
    if (!nextSet.has(link.demandId)) {
      const used = await c.env.DB.prepare(
        `SELECT 1 FROM task_demand_scopes tds INNER JOIN project_tasks pt ON pt.id=tds.task_id WHERE pt.project_id=? AND tds.demand_id=? LIMIT 1`,
      ).bind(project.id, link.demandId).first();
      if (used) return c.json(apiError('PROJECT_DEMAND_PROTECTED', '已被执行任务引用的需求不能从项目中移除', { demandId: link.demandId }), 422);
    }
  }
  const request = { expectedVersion: version, demandIds }, hash = await requestHash(request), operation = `reserve-projects.demands:${project.id}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), now = new Date().toISOString();
  const response = { ok: true as const, data: { projectId: project.id, version: version + 1, demandIds } };
  try {
    await c.env.DB.batch([
      projectVersionGuard(c.env.DB, project.id, version, now, 'draft'),
      c.env.DB.prepare(`DELETE FROM project_demand_links WHERE project_id=?`).bind(project.id),
      ...demandIds.map((demandId) => c.env.DB.prepare(`INSERT INTO project_demand_links (id,project_id,demand_id,created_by,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), project.id, demandId, actor.id, now)),
      auditStatement(c.env.DB, actor.id, 'reserve_project.demands.replace', 'project', project.id, { demandIds: currentLinks.map((item) => item.demandId) }, { demandIds }, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, now),
    ]);
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
  }
  return c.json(response);
});

p8App.put('/reserve-projects/:id/materials', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion), reason = cleanText(body.reason), materials = await normalizeProjectMaterials(c.env.DB, body.materials, true);
  if (version === null || !reason || reason.length > 500 || !materials) return c.json(apiError('INVALID_PROJECT_MATERIALS', 'expectedVersion、调整原因或项目物资无效'), 422);
  const project = await findProject(c.env.DB, c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!await canProject(c, project.id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权修改该项目'), 403);
  if (project.version !== version) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const beforeRows = await loadProjectMaterials(c.env.DB, project.id), before = beforeRows.map(projectMaterialSummary), beforeById = new Map(beforeRows.map((row) => [row.id, row]));
  const assigned = await c.env.DB.prepare(
    `SELECT tmr.project_material_requirement_id AS id,COALESCE(SUM(tmr.required_quantity_scaled),0) AS total
     FROM task_material_requirements tmr INNER JOIN project_tasks pt ON pt.id=tmr.task_id
     WHERE pt.project_id=? AND tmr.project_material_requirement_id IS NOT NULL
     GROUP BY tmr.project_material_requirement_id`,
  ).bind(project.id).all<{ id: string; total: number }>();
  const assignedById = new Map((assigned.results ?? []).map((row) => [row.id, Number(row.total)]));
  const incomingById = new Map(materials.filter((item) => item.id).map((item) => [item.id!, item]));
  for (const old of beforeRows) {
    const protectedQuantity = assignedById.get(old.id) ?? 0;
    const next = incomingById.get(old.id);
    if (protectedQuantity > 0 && (!next || next.requiredQuantityScaled < protectedQuantity || next.model !== old.model || next.unit !== old.unit)) {
      return c.json(apiError('PROJECT_MATERIAL_PROTECTED', '项目物资已分配到执行任务，不能删除、换型或缩减到任务分配量以下', {
        projectMaterialRequirementId: old.id,
        protectedQuantityScaled: protectedQuantity,
        requestedQuantityScaled: next?.requiredQuantityScaled ?? 0,
      }), 422);
    }
  }
  for (const item of materials) if (item.id && !beforeById.has(item.id)) return c.json(apiError('PROJECT_MATERIAL_NOT_FOUND', '项目物资明细不属于当前项目'), 422);
  const request = { expectedVersion: version, reason, materials }, hash = await requestHash(request), operation = `reserve-projects.materials:${project.id}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), now = new Date().toISOString();
  const normalizedRows = materials.map((item) => ({ id: item.id ?? crypto.randomUUID(), item }));
  const after = normalizedRows.map(({ id, item }) => ({
    id,
    projectId: project.id,
    materialId: item.materialId,
    model: item.model,
    unit: item.unit,
    requiredQuantityScaled: item.requiredQuantityScaled,
    unitPriceScaled: item.unitPriceScaled,
    amountFen: item.amountFen,
    reserveCategoryId: item.reserveCategoryId,
    version: (item.id ? beforeById.get(item.id)?.version ?? 0 : 0) + 1,
  }));
  const response = { ok: true as const, data: { projectId: project.id, version: version + 1, materialRequirements: after } };
  try {
    const statements: D1PreparedStatement[] = [
      projectVersionGuard(c.env.DB, project.id, version, now, 'draft'),
      c.env.DB.prepare(`UPDATE project_material_requirements SET active=0,updated_at=? WHERE project_id=? AND active=1`).bind(now, project.id),
    ];
    for (const row of normalizedRows) {
      if (row.item.id) {
        statements.push(c.env.DB.prepare(
          `UPDATE project_material_requirements
           SET material_id=?,model=?,unit=?,required_quantity_scaled=?,unit_price_scaled=?,amount_fen=?,reserve_category_id=?,active=1,version=version+1,updated_at=?
           WHERE id=? AND project_id=?`,
        ).bind(row.item.materialId, row.item.model, row.item.unit, row.item.requiredQuantityScaled, row.item.unitPriceScaled, row.item.amountFen, row.item.reserveCategoryId, now, row.id, project.id));
      } else {
        statements.push(c.env.DB.prepare(
          `INSERT INTO project_material_requirements
           (id,project_id,material_id,model,unit,required_quantity_scaled,unit_price_scaled,amount_fen,reserve_category_id,active,version,created_by,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?,?)`,
        ).bind(row.id, project.id, row.item.materialId, row.item.model, row.item.unit, row.item.requiredQuantityScaled, row.item.unitPriceScaled, row.item.amountFen, row.item.reserveCategoryId, actor.id, now, now));
      }
    }
    statements.push(
      c.env.DB.prepare(`INSERT INTO project_material_revisions (id,project_id,project_version,reason,before_json,after_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), project.id, version + 1, reason, JSON.stringify(before), JSON.stringify(after), actor.id, now),
      auditStatement(c.env.DB, actor.id, 'reserve_project.materials.replace', 'project', project.id, before, after, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, now),
    );
    await c.env.DB.batch(statements);
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    const latest = await findProject(c.env.DB, project.id);
    if (latest && latest.version !== version) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('PROJECT_MATERIAL_CONFLICT', '项目物资调整发生冲突'), 409);
  }
  return c.json({ ok: true as const, data: (await fetchReserveProject(c.env.DB, project.id))! });
});

p8App.get('/reserve-projects/:id/material-revisions', async (c) => {
  const project = await findProject(c.env.DB, c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!await canProject(c, project.id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目'), 403);
  const rows = await c.env.DB.prepare(
    `SELECT id,project_version,reason,before_json,after_json,created_at FROM project_material_revisions WHERE project_id=? ORDER BY created_at DESC,id DESC`,
  ).bind(project.id).all<{ id: string; project_version: number; reason: string; before_json: string; after_json: string; created_at: string }>();
  return c.json({ ok: true as const, data: { items: (rows.results ?? []).map((row) => ({
    id: row.id, projectId: project.id, projectVersion: row.project_version, reason: row.reason,
    before: JSON.parse(row.before_json), after: JSON.parse(row.after_json), createdAt: row.created_at,
  })) } });
});

p8App.post('/reserve-projects/:id/confirm', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const version = expectedVersion(body.expectedVersion), reason = nullableText(body.reason, 500);
  if (version === null || reason === undefined) return c.json(apiError('INVALID_CONFIRMATION', 'expectedVersion 或确认原因无效'), 422);
  const project = await findProject(c.env.DB, c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!await canProject(c, project.id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权确认该项目'), 403);
  if (project.version !== version) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const detail = await fetchReserveProject(c.env.DB, project.id);
  const request = { expectedVersion: version, reason }, hash = await requestHash(request), operation = `reserve-projects.confirm:${project.id}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), now = new Date().toISOString(), reserveVersion = project.reserve_version + 1, nextVersion = version + 1;
  const response = { ok: true as const, data: { projectId: project.id, version: nextVersion, reserveVersion, status: 'confirmed' as const } };
  try {
    await c.env.DB.batch([
      projectVersionGuard(c.env.DB, project.id, version, now, 'confirmed', true),
      c.env.DB.prepare(
        `INSERT INTO project_versions (id,project_id,reserve_version,snapshot_json,known_amount_fen,missing_price_count,completeness_basis_points,reason,confirmed_by,confirmed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).bind(crypto.randomUUID(), project.id, reserveVersion, JSON.stringify(detail), detail!.knownMaterialAmountFen, detail!.missingPriceCount, detail!.materialPriceCompletenessBasisPoints, reason, actor.id, now),
      auditStatement(c.env.DB, actor.id, 'reserve_project.confirm', 'project', project.id, { version, reserveVersion: project.reserve_version }, response.data, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, now),
    ]);
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    return c.json(apiError('VERSION_CONFLICT', '项目确认发生并发冲突，请刷新后重试'), 409);
  }
  return c.json(response);
});

p8App.post('/project-releases', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const projectId = cleanText(body.projectId), version = expectedVersion(body.expectedProjectVersion), releaseDate = validDate(body.releaseDate), note = nullableText(body.note, 1000);
  if (!projectId || version === null || !releaseDate || note === undefined) return c.json(apiError('INVALID_PROJECT_RELEASE', '项目出库参数无效'), 422);
  const project = await findProject(c.env.DB, projectId);
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (!await canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权对该项目出库'), 403);
  if (project.version !== version) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  if (project.status !== 'confirmed' || project.reserve_version < 1) return c.json(apiError('PROJECT_NOT_CONFIRMED', '项目必须先确认储备版本才能出库'), 422);
  const existing = await c.env.DB.prepare(`SELECT id FROM project_releases WHERE project_id=? LIMIT 1`).bind(projectId).first<{ id: string }>();
  if (existing) return c.json(apiError('PROJECT_ALREADY_RELEASED', '该项目已经完成项目级出库'), 409);
  const detail = await fetchReserveProject(c.env.DB, projectId);
  const snapshot = { demandLinks: detail!.demandLinks, materialRequirements: detail!.materialRequirements, projectVersion: version, reserveVersion: project.reserve_version };
  const request = { projectId, expectedProjectVersion: version, releaseDate, note }, hash = await requestHash(request), operation = 'project-releases.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), now = new Date().toISOString(), id = crypto.randomUUID(), nextVersion = version + 1;
  const data = { id, projectId, releaseDate, note, projectVersionSnapshot: version, reserveVersionSnapshot: project.reserve_version, projectVersion: nextVersion, snapshot, createdAt: now };
  const response = { ok: true as const, data };
  try {
    await c.env.DB.batch([
      projectVersionGuard(c.env.DB, projectId, version, now),
      c.env.DB.prepare(`INSERT INTO project_releases (id,project_id,release_date,note,project_version_snapshot,reserve_version_snapshot,snapshot_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(id, projectId, releaseDate, note, version, project.reserve_version, JSON.stringify(snapshot), actor.id, now),
      auditStatement(c.env.DB, actor.id, 'project.release', 'project_release', id, null, data, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 201, now),
    ]);
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    const latest = await findProject(c.env.DB, projectId);
    if (latest && latest.version !== version) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('PROJECT_RELEASE_CONFLICT', '项目出库发生冲突'), 409);
  }
  return c.json(response, 201);
});

p8App.get('/project-releases', async (c) => {
  const projectId = cleanText(c.req.query('projectId'));
  if (!projectId) return c.json(apiError('PROJECT_REQUIRED', 'projectId 不能为空'), 400);
  if (!await canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目出库'), 403);
  const result = await c.env.DB.prepare(`SELECT id,project_id,release_date,note,project_version_snapshot,reserve_version_snapshot,snapshot_json,created_at FROM project_releases WHERE project_id=? ORDER BY created_at DESC`).bind(projectId).all<{
    id: string; project_id: string; release_date: string; note: string | null; project_version_snapshot: number; reserve_version_snapshot: number; snapshot_json: string; created_at: string;
  }>();
  return c.json({ ok: true as const, data: { items: (result.results ?? []).map((row) => ({ id: row.id, projectId: row.project_id, releaseDate: row.release_date, note: row.note, projectVersionSnapshot: row.project_version_snapshot, reserveVersionSnapshot: row.reserve_version_snapshot, snapshot: JSON.parse(row.snapshot_json), createdAt: row.created_at })) } });
});

p8App.post('/project-tasks', requireRoles('admin', 'project_manager', 'implementation'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const projectId = cleanText(body.projectId), projectVersion = expectedVersion(body.expectedProjectVersion), name = cleanText(body.name);
  const description = nullableText(body.description, 1000), scopeText = nullableText(body.scopeText, 1000), owner = nullableText(body.owner, 120), plannedDate = validDate(body.plannedDate);
  const plannedQuantity = positiveInteger(body.plannedQuantityScaled), unit = cleanText(body.unit);
  if (!projectId || projectVersion === null || !name || name.length > 160 || description === undefined || scopeText === undefined || owner === undefined || plannedDate === undefined || plannedQuantity === null || !unit || unit.length > 40) {
    return c.json(apiError('INVALID_PROJECT_TASK', '执行任务参数无效'), 422);
  }
  if (!Array.isArray(body.demandScopes) || body.demandScopes.length > MAX_ITEMS || !Array.isArray(body.materials) || body.materials.length > MAX_ITEMS) return c.json(apiError('INVALID_PROJECT_TASK', '任务需求范围或任务物资格式无效'), 422);
  const project = await findProject(c.env.DB, projectId);
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (!await canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权创建该项目执行任务'), 403);
  if (project.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const release = await c.env.DB.prepare(`SELECT id FROM project_releases WHERE project_id=? LIMIT 1`).bind(projectId).first<{ id: string }>();
  if (!release) return c.json(apiError('PROJECT_NOT_RELEASED', '项目级出库完成后才能创建正式执行任务'), 422);

  const demandScopes: Array<{ demandId: string; quantityScaled: number }> = [];
  const demandSeen = new Set<string>();
  let linkedPlanned = 0;
  for (const raw of body.demandScopes) {
    if (!raw || typeof raw !== 'object') return c.json(apiError('INVALID_TASK_DEMAND_SCOPE', '任务需求范围无效'), 422);
    const item = raw as Record<string, unknown>, demandId = cleanText(item.demandId), quantity = positiveInteger(item.quantityScaled);
    if (!demandId || quantity === null || demandSeen.has(demandId)) return c.json(apiError('INVALID_TASK_DEMAND_SCOPE', '任务需求范围无效或重复'), 422);
    const link = await c.env.DB.prepare(`SELECT 1 FROM project_demand_links WHERE project_id=? AND demand_id=? LIMIT 1`).bind(projectId, demandId).first();
    if (!link) return c.json(apiError('DEMAND_NOT_LINKED_TO_PROJECT', '任务只能关联项目已关联的需求'), 422);
    demandSeen.add(demandId); demandScopes.push({ demandId, quantityScaled: quantity }); linkedPlanned += quantity;
    if (!Number.isSafeInteger(linkedPlanned)) return c.json(apiError('QUANTITY_OVERFLOW', '任务范围数量超出安全整数范围'), 422);
  }
  if (linkedPlanned > plannedQuantity) return c.json(apiError('TASK_DEMAND_SCOPE_EXCEEDS_PLAN', '任务需求范围数量不能超过任务计划数量'), 422);

  const projectMaterialRows = await loadProjectMaterials(c.env.DB, projectId);
  const projectMaterialMap = new Map(projectMaterialRows.map((row) => [row.id, row]));
  const materialSeen = new Set<string>();
  const taskMaterials: Array<{ projectMaterialRequirementId: string; quantityScaled: number; source: ProjectMaterialRow }> = [];
  for (const raw of body.materials) {
    if (!raw || typeof raw !== 'object') return c.json(apiError('INVALID_TASK_MATERIAL', '任务物资无效'), 422);
    const item = raw as Record<string, unknown>, requirementId = cleanText(item.projectMaterialRequirementId), quantity = positiveInteger(item.quantityScaled);
    const source = projectMaterialMap.get(requirementId);
    if (!source || quantity === null || materialSeen.has(requirementId)) return c.json(apiError('INVALID_TASK_MATERIAL', '任务物资必须引用当前项目有效物资且不能重复'), 422);
    materialSeen.add(requirementId); taskMaterials.push({ projectMaterialRequirementId: requirementId, quantityScaled: quantity, source });
  }
  if (taskMaterials.length) {
    const assigned = await c.env.DB.prepare(
      `SELECT project_material_requirement_id AS id,COALESCE(SUM(required_quantity_scaled),0) AS total
       FROM task_material_requirements tmr INNER JOIN project_tasks pt ON pt.id=tmr.task_id
       WHERE pt.project_id=? AND project_material_requirement_id IS NOT NULL GROUP BY project_material_requirement_id`,
    ).bind(projectId).all<{ id: string; total: number }>();
    const assignedMap = new Map((assigned.results ?? []).map((row) => [row.id, Number(row.total)]));
    for (const item of taskMaterials) {
      const after = (assignedMap.get(item.projectMaterialRequirementId) ?? 0) + item.quantityScaled;
      if (after > item.source.required_quantity_scaled) return c.json(apiError('TASK_MATERIAL_EXCEEDS_PROJECT', '任务物资分配合计超过项目当前物资需求，需先调整项目物资', { projectMaterialRequirementId: item.projectMaterialRequirementId, availableQuantityScaled: item.source.required_quantity_scaled - (assignedMap.get(item.projectMaterialRequirementId) ?? 0) }), 422);
    }
  }
  const request = { projectId, expectedProjectVersion: projectVersion, name, description, scopeText, owner, plannedDate, plannedQuantityScaled: plannedQuantity, unit, demandScopes, materials: taskMaterials.map((item) => ({ projectMaterialRequirementId: item.projectMaterialRequirementId, quantityScaled: item.quantityScaled })) };
  const hash = await requestHash(request), operation = 'project-tasks.create'; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), now = new Date().toISOString(), id = crypto.randomUUID(), nextProjectVersion = projectVersion + 1;
  const scopeRows = demandScopes.map((item) => ({ id: crypto.randomUUID(), ...item }));
  const materialRows = taskMaterials.map((item) => ({ id: crypto.randomUUID(), ...item }));
  const data = {
    id, projectId, projectReleaseId: release.id, name, description, scopeText, owner, plannedDate, plannedQuantityScaled: plannedQuantity, unit,
    version: 1, implementationVersion: 1, settlementVersion: 1, projectVersion: nextProjectVersion,
    demandScopes: scopeRows.map((item) => ({ id: item.id, taskId: id, demandId: item.demandId, plannedQuantityScaled: item.quantityScaled })),
    materials: materialRows.map((item) => ({ id: item.id, taskId: id, projectMaterialRequirementId: item.projectMaterialRequirementId, materialId: item.source.material_id, model: item.source.model, unit: item.source.unit, requiredQuantityScaled: item.quantityScaled, supplyVersion: 1, createdAt: now, updatedAt: now })),
    createdAt: now, updatedAt: now,
  };
  const response = { ok: true as const, data };
  try {
    await c.env.DB.batch([
      projectVersionGuard(c.env.DB, projectId, projectVersion, now),
      c.env.DB.prepare(`INSERT INTO project_tasks (id,project_id,project_release_id,name,description,scope_text,owner,planned_date,planned_quantity_scaled,unit,version,implementation_version,settlement_version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,1,1,?,?,?)`).bind(id, projectId, release.id, name, description, scopeText, owner, plannedDate, plannedQuantity, unit, actor.id, now, now),
      ...scopeRows.map((item) => c.env.DB.prepare(`INSERT INTO task_demand_scopes (id,task_id,demand_id,planned_quantity_scaled,created_at) VALUES (?,?,?,?,?)`).bind(item.id, id, item.demandId, item.quantityScaled, now)),
      ...materialRows.map((item) => c.env.DB.prepare(`INSERT INTO task_material_requirements (id,task_id,project_material_requirement_id,material_id,model,unit,required_quantity_scaled,supply_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)`).bind(item.id, id, item.projectMaterialRequirementId, item.source.material_id, item.source.model, item.source.unit, item.quantityScaled, now, now)),
      auditStatement(c.env.DB, actor.id, 'project_task.create', 'project_task', id, null, data, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 201, now),
    ]);
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    const latest = await findProject(c.env.DB, projectId);
    if (latest && latest.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('TASK_CREATE_CONFLICT', '执行任务创建发生冲突'), 409);
  }
  return c.json(response, 201);
});

p8App.get('/project-tasks', async (c) => {
  const projectId = cleanText(c.req.query('projectId'));
  if (!projectId) return c.json(apiError('PROJECT_REQUIRED', 'projectId 不能为空'), 400);
  if (!await canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目任务'), 403);
  const rows = await c.env.DB.prepare(`SELECT id,project_id,project_release_id,name,description,scope_text,owner,planned_date,planned_quantity_scaled,unit,version,implementation_version,settlement_version,created_at,updated_at FROM project_tasks WHERE project_id=? ORDER BY created_at,id`).bind(projectId).all<ProjectTaskRow>();
  const items = [];
  for (const row of rows.results ?? []) items.push(await taskExecutionSummary(c.env.DB, row));
  return c.json({ ok: true as const, data: { items } });
});

p8App.post('/task-material-supply-events', requireRoles('admin', 'project_manager', 'implementation'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const taskMaterialId = cleanText(body.taskMaterialRequirementId), version = expectedVersion(body.expectedSupplyVersion), stage = cleanText(body.stage);
  const quantity = positiveInteger(body.quantityScaled), eventDate = validDate(body.eventDate), note = nullableText(body.note, 1000);
  if (!taskMaterialId || version === null || !['reported','shipped','arrived'].includes(stage) || quantity === null || !eventDate || note === undefined) return c.json(apiError('INVALID_SUPPLY_EVENT', '物资供应事件参数无效'), 422);
  const request = { taskMaterialRequirementId: taskMaterialId, expectedSupplyVersion: version, stage, quantityScaled: quantity, eventDate, note };
  const hash = await requestHash(request), operation = 'task-material-supply-events.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const material = await c.env.DB.prepare(
    `SELECT tmr.id,tmr.task_id,tmr.project_material_requirement_id,tmr.material_id,tmr.model,tmr.unit,tmr.required_quantity_scaled,tmr.supply_version,tmr.created_at,tmr.updated_at,pt.project_id
     FROM task_material_requirements tmr INNER JOIN project_tasks pt ON pt.id=tmr.task_id WHERE tmr.id=? LIMIT 1`,
  ).bind(taskMaterialId).first<TaskMaterialRow & { project_id: string }>();
  if (!material) return c.json(apiError('TASK_MATERIAL_NOT_FOUND', '任务物资不存在'), 404);
  if (!await canProject(c, material.project_id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权登记该任务物资供应'), 403);
  if (material.supply_version !== version) return c.json(apiError('VERSION_CONFLICT', '任务物资供应状态已变化，请刷新后重试'), 409);
  const totals = await supplyTotals(c.env.DB, taskMaterialId);
  const next = { ...totals };
  if (stage === 'reported') next.reportedQuantityScaled += quantity;
  if (stage === 'shipped') next.shippedQuantityScaled += quantity;
  if (stage === 'arrived') next.arrivedQuantityScaled += quantity;
  if (next.reportedQuantityScaled > material.required_quantity_scaled || next.shippedQuantityScaled > next.reportedQuantityScaled || next.arrivedQuantityScaled > next.shippedQuantityScaled) {
    return c.json(apiError('SUPPLY_STAGE_ORDER_VIOLATION', '物资供应累计数量必须满足：已到货 <= 已发货 <= 已上报 <= 任务需求量', { requiredQuantityScaled: material.required_quantity_scaled, totals: next }), 422);
  }
  const actor = c.get('currentUser'), now = new Date().toISOString(), id = crypto.randomUUID();
  const data = { id, taskMaterialRequirementId: taskMaterialId, taskId: material.task_id, stage, quantityScaled: quantity, eventDate, note, supplyVersion: version + 1, totals: next, createdAt: now };
  const response = { ok: true as const, data };
  try {
    await c.env.DB.batch([
      supplyVersionGuard(c.env.DB, taskMaterialId, version, now),
      c.env.DB.prepare(`INSERT INTO material_supply_events (id,task_material_requirement_id,stage,quantity_scaled,event_date,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`).bind(id, taskMaterialId, stage, quantity, eventDate, note, actor.id, now),
      auditStatement(c.env.DB, actor.id, 'task_material.supply', 'task_material_requirement', taskMaterialId, totals, next, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 201, now),
    ]);
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    return c.json(apiError('VERSION_CONFLICT', '任务物资供应状态已被并发修改，请刷新后重试'), 409);
  }
  return c.json(response, 201);
});

p8App.post('/task-implementations', requireRoles('admin', 'project_manager', 'implementation'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const taskId = cleanText(body.taskId), version = expectedVersion(body.expectedImplementationVersion), recordDate = validDate(body.recordDate), note = nullableText(body.note, 1000);
  if (!taskId || version === null || !recordDate || note === undefined || !Array.isArray(body.scopeLines) || body.scopeLines.length > MAX_ITEMS || !Array.isArray(body.materialUsages) || body.materialUsages.length > MAX_ITEMS) return c.json(apiError('INVALID_TASK_IMPLEMENTATION', '任务实施参数无效'), 422);
  const task = await findTask(c.env.DB, taskId);
  if (!task) return c.json(apiError('TASK_NOT_FOUND', '执行任务不存在'), 404);
  if (!await canProject(c, task.project_id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权登记该任务实施'), 403);
  if (task.implementation_version !== version) return c.json(apiError('VERSION_CONFLICT', '任务实施状态已变化，请刷新后重试'), 409);
  const scopes = await loadTaskDemandScopes(c.env.DB, taskId), scopeMap = new Map(scopes.map((item) => [item.id, item]));
  const scopeLines: Array<{ taskDemandScopeId: string; completedQuantityScaled: number }> = [], scopeSeen = new Set<string>();
  let scopedQuantity = 0;
  for (const raw of body.scopeLines) {
    if (!raw || typeof raw !== 'object') return c.json(apiError('INVALID_IMPLEMENTATION_SCOPE', '实施需求范围无效'), 422);
    const item = raw as Record<string, unknown>, scopeId = cleanText(item.taskDemandScopeId), quantity = positiveInteger(item.completedQuantityScaled);
    if (!scopeMap.has(scopeId) || quantity === null || scopeSeen.has(scopeId)) return c.json(apiError('INVALID_IMPLEMENTATION_SCOPE', '实施需求范围不属于任务或存在重复'), 422);
    scopeSeen.add(scopeId); scopeLines.push({ taskDemandScopeId: scopeId, completedQuantityScaled: quantity }); scopedQuantity += quantity;
  }
  const completedQuantity = body.completedQuantityScaled === undefined ? scopedQuantity : positiveInteger(body.completedQuantityScaled);
  if (completedQuantity === null || completedQuantity <= 0 || scopedQuantity > completedQuantity) return c.json(apiError('INVALID_IMPLEMENTATION_QUANTITY', '实施完成量必须为正且不小于需求范围完成量'), 422);
  const plannedLinked = scopes.reduce((sum, scope) => sum + scope.planned_quantity_scaled, 0);
  if (plannedLinked === task.planned_quantity_scaled && scopedQuantity !== completedQuantity) return c.json(apiError('IMPLEMENTATION_SCOPE_MISMATCH', '任务范围已全部关联需求时，实施完成量必须与需求范围明细合计一致'), 422);
  const previousTotal = await c.env.DB.prepare(`SELECT COALESCE(SUM(completed_quantity_scaled),0) AS total FROM task_implementation_records WHERE task_id=?`).bind(taskId).first<{ total: number }>();
  if (Number(previousTotal?.total ?? 0) + completedQuantity > task.planned_quantity_scaled) return c.json(apiError('IMPLEMENTATION_EXCEEDS_TASK', '累计实施完成量超过任务计划量'), 422);
  for (const line of scopeLines) {
    const used = await c.env.DB.prepare(`SELECT COALESCE(SUM(completed_quantity_scaled),0) AS total FROM task_implementation_scope_lines WHERE task_demand_scope_id=?`).bind(line.taskDemandScopeId).first<{ total: number }>();
    if (Number(used?.total ?? 0) + line.completedQuantityScaled > scopeMap.get(line.taskDemandScopeId)!.planned_quantity_scaled) return c.json(apiError('IMPLEMENTATION_EXCEEDS_DEMAND_SCOPE', '实施完成量超过任务需求范围'), 422);
  }
  const materials = await loadTaskMaterials(c.env.DB, taskId), materialMap = new Map(materials.map((item) => [item.id, item]));
  const usages: Array<{ taskMaterialRequirementId: string; quantityScaled: number }> = [], usageSeen = new Set<string>();
  for (const raw of body.materialUsages) {
    if (!raw || typeof raw !== 'object') return c.json(apiError('INVALID_MATERIAL_USAGE', '实施物资使用明细无效'), 422);
    const item = raw as Record<string, unknown>, materialId = cleanText(item.taskMaterialRequirementId), quantity = nonNegativeInteger(item.quantityScaled);
    if (!materialMap.has(materialId) || quantity === null || usageSeen.has(materialId)) return c.json(apiError('INVALID_MATERIAL_USAGE', '实施物资使用明细不属于任务或存在重复'), 422);
    const used = await c.env.DB.prepare(`SELECT COALESCE(SUM(tmul.quantity_scaled),0) AS total FROM task_material_usage_lines tmul INNER JOIN task_implementation_records tir ON tir.id=tmul.implementation_id WHERE tmul.task_material_requirement_id=?`).bind(materialId).first<{ total: number }>();
    if (Number(used?.total ?? 0) + quantity > materialMap.get(materialId)!.required_quantity_scaled) return c.json(apiError('MATERIAL_USAGE_EXCEEDS_TASK', '累计实际物资使用量超过任务物资需求，需先做明确范围变更'), 422);
    usageSeen.add(materialId); usages.push({ taskMaterialRequirementId: materialId, quantityScaled: quantity });
  }
  const request = { taskId, expectedImplementationVersion: version, recordDate, completedQuantityScaled: completedQuantity, scopeLines, materialUsages: usages, note };
  const hash = await requestHash(request), operation = 'task-implementations.create'; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), now = new Date().toISOString(), id = crypto.randomUUID();
  const finalSettlement = await c.env.DB.prepare(`SELECT id FROM task_settlements WHERE task_id=? AND final=1 AND voided_at IS NULL LIMIT 1`).bind(taskId).first<{ id: string }>();
  const existingReminder = await c.env.DB.prepare(`SELECT first_implementation_date FROM task_settlement_reminders WHERE task_id=? LIMIT 1`).bind(taskId).first<{ first_implementation_date: string }>();
  const firstImplementationDate = existingReminder && existingReminder.first_implementation_date < recordDate ? existingReminder.first_implementation_date : recordDate;
  const data = { id, taskId, recordDate, completedQuantityScaled: completedQuantity, scopeLines, materialUsages: usages, note, implementationVersion: version + 1, createdAt: now };
  const response = { ok: true as const, data };
  try {
    await c.env.DB.batch([
      taskImplementationVersionGuard(c.env.DB, taskId, version, now),
      c.env.DB.prepare(`INSERT INTO task_implementation_records (id,task_id,record_date,completed_quantity_scaled,note,created_by,created_at) VALUES (?,?,?,?,?,?,?)`).bind(id, taskId, recordDate, completedQuantity, note, actor.id, now),
      ...scopeLines.map((line) => c.env.DB.prepare(`INSERT INTO task_implementation_scope_lines (id,implementation_id,task_demand_scope_id,completed_quantity_scaled,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), id, line.taskDemandScopeId, line.completedQuantityScaled, now)),
      ...usages.map((line) => c.env.DB.prepare(`INSERT INTO task_material_usage_lines (id,implementation_id,task_material_requirement_id,quantity_scaled,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), id, line.taskMaterialRequirementId, line.quantityScaled, now)),
      c.env.DB.prepare(
        `INSERT INTO task_settlement_reminders (task_id,first_implementation_date,due_date,status,final_settlement_id,updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET first_implementation_date=excluded.first_implementation_date,due_date=excluded.due_date,status=excluded.status,final_settlement_id=excluded.final_settlement_id,updated_at=excluded.updated_at`,
      ).bind(taskId, firstImplementationDate, addDays(firstImplementationDate, 30), finalSettlement ? 'closed' : 'open', finalSettlement?.id ?? null, now),
      auditStatement(c.env.DB, actor.id, 'project_task.implementation', 'project_task', taskId, { implementationVersion: version }, { implementationVersion: version + 1, completedQuantityScaled: completedQuantity }, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 201, now),
    ]);
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    return c.json(apiError('VERSION_CONFLICT', '任务实施状态已被并发修改，请刷新后重试'), 409);
  }
  return c.json(response, 201);
});

p8App.post('/task-settlements', requireRoles('admin', 'project_manager', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const taskId = cleanText(body.taskId), version = expectedVersion(body.expectedSettlementVersion), settlementDate = validDate(body.settlementDate), amountFen = nonNegativeInteger(body.amountFen), final = body.final === true, note = nullableText(body.note, 1000);
  if (!taskId || version === null || !settlementDate || amountFen === null || note === undefined || !Array.isArray(body.coverage) || body.coverage.length > MAX_ITEMS || !Array.isArray(body.agreementAllocations) || body.agreementAllocations.length > MAX_ITEMS) return c.json(apiError('INVALID_TASK_SETTLEMENT', '任务结算参数无效'), 422);
  const task = await findTask(c.env.DB, taskId);
  if (!task) return c.json(apiError('TASK_NOT_FOUND', '执行任务不存在'), 404);
  if (!await canProject(c, task.project_id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权登记该任务结算'), 403);
  if (task.settlement_version !== version) return c.json(apiError('VERSION_CONFLICT', '任务结算状态已变化，请刷新后重试'), 409);
  const scopes = await loadTaskDemandScopes(c.env.DB, taskId), scopeMap = new Map(scopes.map((item) => [item.id, item]));
  const coverage: Array<{ taskDemandScopeId: string; quantityScaled: number }> = [], coverageSeen = new Set<string>();
  let scopedCoverage = 0;
  for (const raw of body.coverage) {
    if (!raw || typeof raw !== 'object') return c.json(apiError('INVALID_SETTLEMENT_COVERAGE', '结算需求范围无效'), 422);
    const item = raw as Record<string, unknown>, scopeId = cleanText(item.taskDemandScopeId), quantity = positiveInteger(item.quantityScaled);
    if (!scopeMap.has(scopeId) || quantity === null || coverageSeen.has(scopeId)) return c.json(apiError('INVALID_SETTLEMENT_COVERAGE', '结算需求范围不属于任务或存在重复'), 422);
    coverageSeen.add(scopeId); coverage.push({ taskDemandScopeId: scopeId, quantityScaled: quantity }); scopedCoverage += quantity;
  }
  const coverageQuantity = body.coverageQuantityScaled === undefined ? scopedCoverage : positiveInteger(body.coverageQuantityScaled);
  if (coverageQuantity === null || coverageQuantity <= 0 || scopedCoverage > coverageQuantity) return c.json(apiError('INVALID_SETTLEMENT_QUANTITY', '结算覆盖量必须为正且不小于需求范围覆盖量'), 422);
  const plannedLinked = scopes.reduce((sum, scope) => sum + scope.planned_quantity_scaled, 0);
  if (plannedLinked === task.planned_quantity_scaled && scopedCoverage !== coverageQuantity) return c.json(apiError('SETTLEMENT_SCOPE_MISMATCH', '任务范围已全部关联需求时，结算覆盖量必须与需求范围明细合计一致'), 422);
  const previousTotal = await c.env.DB.prepare(`SELECT COALESCE(SUM(coverage_quantity_scaled),0) AS total FROM task_settlements WHERE task_id=? AND voided_at IS NULL`).bind(taskId).first<{ total: number }>();
  const afterTotal = Number(previousTotal?.total ?? 0) + coverageQuantity;
  if (afterTotal > task.planned_quantity_scaled) return c.json(apiError('SETTLEMENT_EXCEEDS_TASK', '累计结算覆盖量超过任务计划量'), 422);
  for (const line of coverage) {
    const used = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(tsl.quantity_scaled),0) AS total FROM task_settlement_scope_lines tsl INNER JOIN task_settlements ts ON ts.id=tsl.settlement_id WHERE tsl.task_demand_scope_id=? AND ts.voided_at IS NULL`,
    ).bind(line.taskDemandScopeId).first<{ total: number }>();
    if (Number(used?.total ?? 0) + line.quantityScaled > scopeMap.get(line.taskDemandScopeId)!.planned_quantity_scaled) return c.json(apiError('SETTLEMENT_EXCEEDS_DEMAND_SCOPE', '结算覆盖量超过任务需求范围'), 422);
  }
  if (final) {
    if (afterTotal !== task.planned_quantity_scaled) return c.json(apiError('FINAL_SETTLEMENT_INCOMPLETE', '最终结算必须覆盖任务全部计划范围'), 422);
    for (const scope of scopes) {
      const current = await c.env.DB.prepare(
        `SELECT COALESCE(SUM(tsl.quantity_scaled),0) AS total FROM task_settlement_scope_lines tsl INNER JOIN task_settlements ts ON ts.id=tsl.settlement_id WHERE tsl.task_demand_scope_id=? AND ts.voided_at IS NULL`,
      ).bind(scope.id).first<{ total: number }>();
      const added = coverage.find((item) => item.taskDemandScopeId === scope.id)?.quantityScaled ?? 0;
      if (Number(current?.total ?? 0) + added !== scope.planned_quantity_scaled) return c.json(apiError('FINAL_SETTLEMENT_INCOMPLETE', '最终结算必须完整覆盖全部已关联需求范围', { taskDemandScopeId: scope.id }), 422);
    }
  }
  const allocations: Array<{ agreementId: string; amountFen: number }> = [], agreementSeen = new Set<string>();
  let allocationTotal = 0;
  const project = await findProject(c.env.DB, task.project_id);
  for (const raw of body.agreementAllocations) {
    if (!raw || typeof raw !== 'object') return c.json(apiError('INVALID_SETTLEMENT_AGREEMENT', '结算协议分摊无效'), 422);
    const item = raw as Record<string, unknown>, agreementId = cleanText(item.agreementId), amount = nonNegativeInteger(item.amountFen);
    if (!agreementId || amount === null || agreementSeen.has(agreementId)) return c.json(apiError('INVALID_SETTLEMENT_AGREEMENT', '结算协议分摊无效或重复'), 422);
    if (!project?.framework_id) return c.json(apiError('PROJECT_FRAMEWORK_REQUIRED', '项目未归属框架，不能填写结算协议分摊'), 422);
    const agreement = await c.env.DB.prepare(`SELECT framework_id,status,valid_from,valid_to FROM agreements WHERE id=? LIMIT 1`).bind(agreementId).first<{ framework_id: string; status: string; valid_from: string; valid_to: string }>();
    if (!agreement || agreement.framework_id !== project.framework_id) return c.json(apiError('AGREEMENT_FRAMEWORK_MISMATCH', '结算协议与项目不属于同一框架'), 422);
    if (agreement.status !== 'active' || settlementDate < agreement.valid_from || settlementDate > agreement.valid_to) return c.json(apiError('AGREEMENT_NOT_EFFECTIVE', '结算协议在结算日期无效'), 422);
    agreementSeen.add(agreementId); allocations.push({ agreementId, amountFen: amount }); allocationTotal += amount;
  }
  if (allocations.length && allocationTotal !== amountFen) return c.json(apiError('SETTLEMENT_AGREEMENT_MISMATCH', '结算协议分摊金额必须精确等于结算金额'), 422);
  const request = { taskId, expectedSettlementVersion: version, settlementDate, coverageQuantityScaled: coverageQuantity, amountFen, final, note, coverage, agreementAllocations: allocations };
  const hash = await requestHash(request), operation = 'task-settlements.create'; const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), now = new Date().toISOString(), id = crypto.randomUUID();
  const data = { id, taskId, settlementDate, coverageQuantityScaled: coverageQuantity, amountFen, final, note, coverage, agreementAllocations: allocations, version: 1, settlementVersion: version + 1, voidedAt: null, voidReason: null, createdAt: now, updatedAt: now };
  const response = { ok: true as const, data };
  try {
    const statements: D1PreparedStatement[] = [
      taskSettlementVersionGuard(c.env.DB, taskId, version, now),
      c.env.DB.prepare(`INSERT INTO task_settlements (id,task_id,settlement_date,coverage_quantity_scaled,amount_fen,final,note,version,voided_at,voided_by,void_reason,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,NULL,NULL,NULL,?,?,?)`).bind(id, taskId, settlementDate, coverageQuantity, amountFen, final ? 1 : 0, note, actor.id, now, now),
      ...coverage.map((line) => c.env.DB.prepare(`INSERT INTO task_settlement_scope_lines (id,settlement_id,task_demand_scope_id,quantity_scaled,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), id, line.taskDemandScopeId, line.quantityScaled, now)),
      ...allocations.map((line) => c.env.DB.prepare(`INSERT INTO task_settlement_agreement_allocations (id,settlement_id,agreement_id,amount_fen,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), id, line.agreementId, line.amountFen, now)),
    ];
    if (final) statements.push(c.env.DB.prepare(`UPDATE task_settlement_reminders SET status='closed',final_settlement_id=?,updated_at=? WHERE task_id=?`).bind(id, now, taskId));
    statements.push(
      auditStatement(c.env.DB, actor.id, 'project_task.settlement', 'project_task', taskId, { settlementVersion: version }, { settlementVersion: version + 1, coverageQuantityScaled: coverageQuantity, final }, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 201, now),
    );
    await c.env.DB.batch(statements);
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    return c.json(apiError('VERSION_CONFLICT', '任务结算状态已被并发修改，请刷新后重试'), 409);
  }
  return c.json(response, 201);
});

p8App.post('/task-settlements/:id/void', requireRoles('admin', 'project_manager', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expectedSettlementVersion = expectedVersion(body.expectedSettlementVersion), recordVersion = expectedVersion(body.expectedVersion), reason = cleanText(body.reason);
  if (expectedSettlementVersion === null || recordVersion === null || !reason || reason.length > 1000) return c.json(apiError('INVALID_SETTLEMENT_VOID', '撤销版本或原因无效'), 422);
  const row = await c.env.DB.prepare(`SELECT id,task_id,version,voided_at,final FROM task_settlements WHERE id=? LIMIT 1`).bind(c.req.param('id')).first<{ id: string; task_id: string; version: number; voided_at: string | null; final: number }>();
  if (!row) return c.json(apiError('TASK_SETTLEMENT_NOT_FOUND', '任务结算不存在'), 404);
  const task = await findTask(c.env.DB, row.task_id);
  if (!task || !await canProject(c, task.project_id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权撤销该任务结算'), 403);
  if (row.voided_at) return c.json(apiError('SETTLEMENT_ALREADY_VOIDED', '该任务结算已撤销'), 409);
  if (row.version !== recordVersion || task.settlement_version !== expectedSettlementVersion) return c.json(apiError('VERSION_CONFLICT', '任务结算状态已变化，请刷新后重试'), 409);
  const request = { expectedSettlementVersion, expectedVersion: recordVersion, reason }, hash = await requestHash(request), operation = `task-settlements.void:${row.id}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), now = new Date().toISOString(), response = { ok: true as const, data: { id: row.id, taskId: row.task_id, version: recordVersion + 1, settlementVersion: expectedSettlementVersion + 1, voidedAt: now, voidReason: reason } };
  const firstImplementation = await c.env.DB.prepare(`SELECT MIN(record_date) AS first_date FROM task_implementation_records WHERE task_id=?`).bind(row.task_id).first<{ first_date: string | null }>();
  try {
    const statements: D1PreparedStatement[] = [
      taskSettlementVersionGuard(c.env.DB, row.task_id, expectedSettlementVersion, now),
      c.env.DB.prepare(`UPDATE task_settlements SET voided_at=?,voided_by=?,void_reason=?,version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END WHERE id=? AND voided_at IS NULL`).bind(now, actor.id, reason, recordVersion, now, row.id),
    ];
    if (row.final === 1 && firstImplementation?.first_date) {
      const replacementFinal = await c.env.DB.prepare(`SELECT id FROM task_settlements WHERE task_id=? AND final=1 AND voided_at IS NULL AND id<>? LIMIT 1`).bind(row.task_id, row.id).first<{ id: string }>();
      statements.push(c.env.DB.prepare(`UPDATE task_settlement_reminders SET status=?,final_settlement_id=?,updated_at=? WHERE task_id=?`).bind(replacementFinal ? 'closed' : 'open', replacementFinal?.id ?? null, now, row.task_id));
    }
    statements.push(
      auditStatement(c.env.DB, actor.id, 'project_task.settlement.void', 'task_settlement', row.id, { voidedAt: null }, response.data, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, now),
    );
    await c.env.DB.batch(statements);
  } catch {
    const race = await replayIdempotentResponse(c, key, operation, hash); if (race) return race;
    return c.json(apiError('VERSION_CONFLICT', '任务结算已被并发修改，请刷新后重试'), 409);
  }
  return c.json(response);
});

p8App.get('/demands/:id/execution', async (c) => {
  const summary = await demandExecutionSummary(c.env.DB, c.req.param('id'));
  if (!summary) return c.json(apiError('DEMAND_NOT_FOUND', '需求不存在'), 404);
  const projects = await c.env.DB.prepare(`SELECT project_id FROM project_demand_links WHERE demand_id=?`).bind(c.req.param('id')).all<{ project_id: string }>();
  if (c.get('currentUser').role !== 'admin' && !c.get('currentUser').scopes.some((scope) => scope.type === 'all')) {
    let allowed = false;
    for (const project of projects.results ?? []) if (await canProject(c, project.project_id)) { allowed = true; break; }
    if (!allowed && (projects.results ?? []).length) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该需求执行反馈'), 403);
  }
  return c.json({ ok: true as const, data: summary });
});

p8App.get('/projects/:id/execution', async (c) => {
  const project = await findProject(c.env.DB, c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (!await canProject(c, project.id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目执行状态'), 403);
  const taskRows = await c.env.DB.prepare(`SELECT id,project_id,project_release_id,name,description,scope_text,owner,planned_date,planned_quantity_scaled,unit,version,implementation_version,settlement_version,created_at,updated_at FROM project_tasks WHERE project_id=? ORDER BY created_at,id`).bind(project.id).all<ProjectTaskRow>();
  const tasks = [];
  for (const task of taskRows.results ?? []) tasks.push(await taskExecutionSummary(c.env.DB, task));
  const links = await loadProjectDemandLinks(c.env.DB, project.id), demands = [];
  for (const link of links) demands.push(await demandExecutionSummary(c.env.DB, link.demandId));
  const activeDemands = demands.filter((item): item is NonNullable<typeof item> => Boolean(item));
  const implementationComplete = activeDemands.length > 0 && activeDemands.every((item) => item.implementationComplete);
  const settlementComplete = activeDemands.length > 0 && activeDemands.every((item) => item.settlementComplete);
  return c.json({ ok: true as const, data: {
    projectId: project.id,
    projectVersion: project.version,
    released: Boolean(await c.env.DB.prepare(`SELECT id FROM project_releases WHERE project_id=? LIMIT 1`).bind(project.id).first()),
    tasks,
    demands: activeDemands,
    implementationComplete,
    settlementComplete,
    projectState: lifecycleState(implementationComplete, settlementComplete),
  } });
});
