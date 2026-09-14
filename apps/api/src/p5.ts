import { Hono, type Context } from 'hono';
import type {
  ApiError,
  AttachmentSummary,
  BudgetAllocationSummary,
  CreateImplementationRequest,
  CreateReleaseBatchRequest,
  CreateSettlementRequest,
  DemandLifecycleSummary,
  HistoricalImplementationLinkInput,
  ImplementationLineSummary,
  ImplementationRecordSummary,
  LifecycleLineSummary,
  LifecycleState,
  LinkHistoricalImplementationRequest,
  ProjectLifecycleSummary,
  ReleaseBatchSummary,
  ReleaseLineSummary,
  SettlementAgreementAllocationInput,
  SettlementCoverageInput,
  SettlementSummary,
  VoidSettlementRequest,
} from '@tpm/shared';
import { deleteAttachmentContent, loadAttachmentContent, saveAttachmentContent } from './application/attachment-content';
import { hasScope, requireRoles, type AppEnv } from './auth';
import type { AttachmentRecord } from './ports/attachment-repository';
import { SqlAttachmentRepository } from './repositories/sql-attachment-repository';
import { createCloudflarePersistence } from './runtime/cloudflare/persistence';

const MAX_LINES = 100;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

type ProjectRow = {
  id: string;
  name: string;
  framework_id: string | null;
  status: 'draft' | 'confirmed';
  reserve_version: number;
  version: number;
  updated_at: string;
};

type ScopeRow = {
  allocation_id: string;
  demand_material_id: string;
  quantity_scaled: number;
  raw_model: string;
  unit: string | null;
  demand_id: string;
  line_name: string;
  section_text: string;
};

type ReleaseLineRow = {
  id: string;
  release_batch_id: string;
  project_id: string;
  demand_material_id: string;
  quantity_scaled: number;
  snapshot_json: string;
  created_at: string;
};

type ReleaseBatchRow = {
  id: string;
  project_id: string;
  release_date: string;
  note: string | null;
  project_version_snapshot: number;
  reserve_version_snapshot: number;
  created_at: string;
};

type ImplementationRecordRow = {
  id: string;
  project_id: string | null;
  historical: number;
  record_date: string;
  personnel: string | null;
  note: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type ImplementationLineRow = {
  id: string;
  implementation_id: string;
  project_id: string | null;
  release_line_id: string | null;
  demand_material_id: string | null;
  description: string | null;
  unit: string | null;
  completed_quantity_scaled: number;
  actual_used_quantity_scaled: number | null;
  created_at: string;
};

type SettlementRow = {
  id: string;
  project_id: string;
  settlement_date: string;
  amount_fen: number;
  final: number;
  note: string | null;
  version: number;
  voided_at: string | null;
  void_reason: string | null;
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

function validDate(value: unknown): string | null {
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? null : text;
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function safeSum(values: number[]): number | null {
  let total = 0n;
  for (const value of values) total += BigInt(value);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) && total >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(total) : null;
}

function canProject(c: Context<AppEnv>, projectId: string) {
  const user = c.get('currentUser');
  return user.role === 'admin' || hasScope(user.scopes, 'project', projectId);
}

function requireIdempotencyKey(c: Context<AppEnv>): string | Response {
  const key = c.req.header('Idempotency-Key')?.trim();
  if (!key || key.length > 200) return c.json(apiError('IDEMPOTENCY_KEY_REQUIRED', '变更请求必须提供有效的 Idempotency-Key'), 400);
  return key;
}

async function requestHash(value: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function bytesHash(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
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

async function findProject(db: D1Database, id: string) {
  return db.prepare(
    `SELECT id,name,framework_id,status,reserve_version,version,updated_at FROM projects WHERE id=? LIMIT 1`,
  ).bind(id).first<ProjectRow>();
}

function projectVersionGuard(db: D1Database, projectId: string, version: number, now: string) {
  return db.prepare(
    `UPDATE projects SET version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END WHERE id=?`,
  ).bind(version, now, projectId);
}

async function loadProjectScope(db: D1Database, projectId: string) {
  const result = await db.prepare(
    `SELECT da.id AS allocation_id,da.demand_material_id,da.quantity_scaled,dm.raw_model,dm.unit,
            d.id AS demand_id,d.line_name,d.section_text
     FROM demand_allocations da
     INNER JOIN demand_materials dm ON dm.id=da.demand_material_id
     INNER JOIN demands d ON d.id=dm.demand_id
     WHERE da.project_id=? ORDER BY d.line_name,d.section_text,da.id`,
  ).bind(projectId).all<ScopeRow>();
  return result.results ?? [];
}

async function quantityMap(db: D1Database, sql: string, projectId: string) {
  const result = await db.prepare(sql).bind(projectId).all<{ demand_material_id: string; total: number }>();
  return new Map((result.results ?? []).map((row) => [row.demand_material_id, Number(row.total)]));
}

async function releasedTotals(db: D1Database, projectId: string) {
  return quantityMap(db,
    `SELECT demand_material_id,COALESCE(SUM(quantity_scaled),0) AS total
     FROM release_lines WHERE project_id=? GROUP BY demand_material_id`, projectId);
}

async function implementedTotals(db: D1Database, projectId: string) {
  return quantityMap(db,
    `SELECT demand_material_id,COALESCE(SUM(completed_quantity_scaled),0) AS total
     FROM implementation_lines WHERE project_id=? AND demand_material_id IS NOT NULL GROUP BY demand_material_id`, projectId);
}

async function activeSettlementTotals(db: D1Database, projectId: string) {
  return quantityMap(db,
    `SELECT sc.demand_material_id,COALESCE(SUM(sc.quantity_scaled),0) AS total
     FROM settlement_coverage sc INNER JOIN settlements s ON s.id=sc.settlement_id
     WHERE sc.project_id=? AND s.voided_at IS NULL GROUP BY sc.demand_material_id`, projectId);
}

function lifecycleState(implemented: boolean, settled: boolean): LifecycleState {
  if (implemented && settled) return 'implemented_settled';
  if (implemented) return 'implemented_unsettled';
  if (settled) return 'unimplemented_settled';
  return 'unimplemented_unsettled';
}

function parseReleaseSnapshot(value: string): ReleaseLineSummary['snapshot'] {
  const parsed = JSON.parse(value) as ReleaseLineSummary['snapshot'];
  return parsed;
}

function releaseLineSummary(row: ReleaseLineRow): ReleaseLineSummary {
  return {
    id: row.id,
    releaseBatchId: row.release_batch_id,
    demandMaterialId: row.demand_material_id,
    quantityScaled: row.quantity_scaled,
    snapshot: parseReleaseSnapshot(row.snapshot_json),
  };
}

async function loadReleaseBatches(db: D1Database, projectId: string): Promise<ReleaseBatchSummary[]> {
  const batches = await db.prepare(
    `SELECT id,project_id,release_date,note,project_version_snapshot,reserve_version_snapshot,created_at
     FROM release_batches WHERE project_id=? ORDER BY release_date DESC,created_at DESC,id DESC LIMIT 100`,
  ).bind(projectId).all<ReleaseBatchRow>();
  const lines = await db.prepare(
    `SELECT rl.id,rl.release_batch_id,rl.project_id,rl.demand_material_id,rl.quantity_scaled,rl.snapshot_json,rl.created_at
     FROM release_lines rl INNER JOIN release_batches rb ON rb.id=rl.release_batch_id
     WHERE rb.project_id=? ORDER BY rb.release_date DESC,rb.created_at DESC,rl.id`,
  ).bind(projectId).all<ReleaseLineRow>();
  const byBatch = new Map<string, ReleaseLineSummary[]>();
  for (const line of lines.results ?? []) {
    const list = byBatch.get(line.release_batch_id) ?? [];
    list.push(releaseLineSummary(line));
    byBatch.set(line.release_batch_id, list);
  }
  const project = await findProject(db, projectId);
  return (batches.results ?? []).map((batch) => ({
    id: batch.id,
    projectId: batch.project_id,
    releaseDate: batch.release_date,
    note: batch.note,
    projectVersionSnapshot: batch.project_version_snapshot,
    reserveVersionSnapshot: batch.reserve_version_snapshot,
    projectVersion: project?.version ?? batch.project_version_snapshot,
    lines: byBatch.get(batch.id) ?? [],
    createdAt: batch.created_at,
  }));
}

function normalizeReleaseLines(value: unknown): CreateReleaseBatchRequest['lines'] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LINES) return null;
  const seen = new Set<string>();
  const lines: CreateReleaseBatchRequest['lines'] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const demandMaterialId = cleanText(item.demandMaterialId);
    const quantityScaled = positiveInteger(item.quantityScaled);
    if (!demandMaterialId || quantityScaled === null || seen.has(demandMaterialId)) return null;
    seen.add(demandMaterialId);
    lines.push({ demandMaterialId, quantityScaled });
  }
  return lines;
}

function normalizeImplementationLines(value: unknown): CreateImplementationRequest['lines'] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LINES) return null;
  const lines: CreateImplementationRequest['lines'] = [];
  const releaseIds = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const releaseLineId = item.releaseLineId === null || item.releaseLineId === undefined ? null : cleanText(item.releaseLineId);
    const description = nullableText(item.description, 500);
    const unit = nullableText(item.unit, 40);
    const completedQuantityScaled = positiveInteger(item.completedQuantityScaled);
    const actualUsedQuantityScaled = item.actualUsedQuantityScaled === null || item.actualUsedQuantityScaled === undefined
      ? null : nonNegativeInteger(item.actualUsedQuantityScaled);
    if (description === undefined || unit === undefined || completedQuantityScaled === null || actualUsedQuantityScaled === null && item.actualUsedQuantityScaled !== null && item.actualUsedQuantityScaled !== undefined) return null;
    if (releaseLineId && releaseIds.has(releaseLineId)) return null;
    if (releaseLineId) releaseIds.add(releaseLineId);
    lines.push({ releaseLineId, description, unit, completedQuantityScaled, actualUsedQuantityScaled });
  }
  return lines;
}

function normalizeCoverage(value: unknown, allowEmpty = false): SettlementCoverageInput[] | null {
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.length > MAX_LINES) return null;
  const seen = new Set<string>();
  const out: SettlementCoverageInput[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const demandMaterialId = cleanText(item.demandMaterialId);
    const quantityScaled = positiveInteger(item.quantityScaled);
    if (!demandMaterialId || quantityScaled === null || seen.has(demandMaterialId)) return null;
    seen.add(demandMaterialId);
    out.push({ demandMaterialId, quantityScaled });
  }
  return out;
}

function normalizeAgreementAllocations(value: unknown): SettlementAgreementAllocationInput[] | null {
  if (!Array.isArray(value) || value.length > MAX_LINES) return null;
  const seen = new Set<string>();
  const out: SettlementAgreementAllocationInput[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const agreementId = cleanText(item.agreementId);
    const amountFen = nonNegativeInteger(item.amountFen);
    if (!agreementId || amountFen === null || seen.has(agreementId)) return null;
    seen.add(agreementId);
    out.push({ agreementId, amountFen });
  }
  return out;
}

async function loadImplementationLines(db: D1Database, implementationId: string) {
  const result = await db.prepare(
    `SELECT id,implementation_id,project_id,release_line_id,demand_material_id,description,unit,completed_quantity_scaled,actual_used_quantity_scaled,created_at
     FROM implementation_lines WHERE implementation_id=? ORDER BY id`,
  ).bind(implementationId).all<ImplementationLineRow>();
  return result.results ?? [];
}

function implementationLineSummary(row: ImplementationLineRow): ImplementationLineSummary {
  return {
    id: row.id,
    implementationId: row.implementation_id,
    projectId: row.project_id,
    releaseLineId: row.release_line_id,
    demandMaterialId: row.demand_material_id,
    description: row.description,
    unit: row.unit,
    completedQuantityScaled: row.completed_quantity_scaled,
    actualUsedQuantityScaled: row.actual_used_quantity_scaled,
  };
}

async function implementationSummary(db: D1Database, row: ImplementationRecordRow, projectVersion: number | null = null): Promise<ImplementationRecordSummary> {
  const lines = await loadImplementationLines(db, row.id);
  return {
    id: row.id,
    projectId: row.project_id,
    historical: row.historical === 1,
    recordDate: row.record_date,
    personnel: row.personnel,
    note: row.note,
    version: row.version,
    projectVersion,
    lines: lines.map(implementationLineSummary),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function implementationSummaries(db: D1Database, rows: ImplementationRecordRow[], projectVersion: number | null): Promise<ImplementationRecordSummary[]> {
  if (rows.length === 0) return [];
  const placeholders = rows.map(() => '?').join(',');
  const lineResult = await db.prepare(
    `SELECT id,implementation_id,project_id,release_line_id,demand_material_id,description,unit,completed_quantity_scaled,actual_used_quantity_scaled,created_at
     FROM implementation_lines WHERE implementation_id IN (${placeholders}) ORDER BY implementation_id,id`,
  ).bind(...rows.map((row) => row.id)).all<ImplementationLineRow>();
  const linesByImplementation = new Map<string, ImplementationLineSummary[]>();
  for (const line of lineResult.results ?? []) {
    const list = linesByImplementation.get(line.implementation_id) ?? [];
    list.push(implementationLineSummary(line));
    linesByImplementation.set(line.implementation_id, list);
  }
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    historical: row.historical === 1,
    recordDate: row.record_date,
    personnel: row.personnel,
    note: row.note,
    version: row.version,
    projectVersion: row.project_id ? projectVersion : null,
    lines: linesByImplementation.get(row.id) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function findImplementation(db: D1Database, id: string) {
  return db.prepare(
    `SELECT id,project_id,historical,record_date,personnel,note,version,created_at,updated_at FROM implementation_records WHERE id=? LIMIT 1`,
  ).bind(id).first<ImplementationRecordRow>();
}

async function loadSettlementCoverage(db: D1Database, settlementId: string) {
  const result = await db.prepare(
    `SELECT demand_material_id,quantity_scaled FROM settlement_coverage WHERE settlement_id=? ORDER BY demand_material_id`,
  ).bind(settlementId).all<{ demand_material_id: string; quantity_scaled: number }>();
  return (result.results ?? []).map((row) => ({ demandMaterialId: row.demand_material_id, quantityScaled: row.quantity_scaled }));
}

async function loadSettlementAgreements(db: D1Database, settlementId: string) {
  const result = await db.prepare(
    `SELECT agreement_id,amount_fen FROM settlement_agreement_allocations WHERE settlement_id=? ORDER BY agreement_id`,
  ).bind(settlementId).all<{ agreement_id: string; amount_fen: number }>();
  return (result.results ?? []).map((row) => ({ agreementId: row.agreement_id, amountFen: row.amount_fen }));
}

async function settlementSummary(db: D1Database, row: SettlementRow, projectVersion: number): Promise<SettlementSummary> {
  const [coverage, agreementAllocations] = await Promise.all([
    loadSettlementCoverage(db, row.id),
    loadSettlementAgreements(db, row.id),
  ]);
  return {
    id: row.id,
    projectId: row.project_id,
    settlementDate: row.settlement_date,
    amountFen: row.amount_fen,
    final: row.final === 1,
    note: row.note,
    version: row.version,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    projectVersion,
    coverage,
    agreementAllocations,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function settlementSummaries(db: D1Database, rows: SettlementRow[], projectVersion: number): Promise<SettlementSummary[]> {
  if (rows.length === 0) return [];
  const placeholders = rows.map(() => '?').join(',');
  const ids = rows.map((row) => row.id);
  const [coverageResult, allocationResult] = await Promise.all([
    db.prepare(
      `SELECT settlement_id,demand_material_id,quantity_scaled
       FROM settlement_coverage WHERE settlement_id IN (${placeholders}) ORDER BY settlement_id,demand_material_id`,
    ).bind(...ids).all<{ settlement_id: string; demand_material_id: string; quantity_scaled: number }>(),
    db.prepare(
      `SELECT settlement_id,agreement_id,amount_fen
       FROM settlement_agreement_allocations WHERE settlement_id IN (${placeholders}) ORDER BY settlement_id,agreement_id`,
    ).bind(...ids).all<{ settlement_id: string; agreement_id: string; amount_fen: number }>(),
  ]);
  const coverageBySettlement = new Map<string, SettlementCoverageInput[]>();
  for (const item of coverageResult.results ?? []) {
    const list = coverageBySettlement.get(item.settlement_id) ?? [];
    list.push({ demandMaterialId: item.demand_material_id, quantityScaled: item.quantity_scaled });
    coverageBySettlement.set(item.settlement_id, list);
  }
  const allocationsBySettlement = new Map<string, SettlementAgreementAllocationInput[]>();
  for (const item of allocationResult.results ?? []) {
    const list = allocationsBySettlement.get(item.settlement_id) ?? [];
    list.push({ agreementId: item.agreement_id, amountFen: item.amount_fen });
    allocationsBySettlement.set(item.settlement_id, list);
  }
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    settlementDate: row.settlement_date,
    amountFen: row.amount_fen,
    final: row.final === 1,
    note: row.note,
    version: row.version,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    projectVersion,
    coverage: coverageBySettlement.get(row.id) ?? [],
    agreementAllocations: allocationsBySettlement.get(row.id) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function findSettlement(db: D1Database, id: string) {
  return db.prepare(
    `SELECT id,project_id,settlement_date,amount_fen,final,note,version,voided_at,void_reason,created_at,updated_at
     FROM settlements WHERE id=? LIMIT 1`,
  ).bind(id).first<SettlementRow>();
}

function attachmentSummary(record: AttachmentRecord): AttachmentSummary {
  return {
    id: record.id,
    projectId: record.projectId,
    objectType: record.objectType,
    objectId: record.objectId,
    fileName: record.fileName,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt,
  };
}

export const p5App = new Hono<AppEnv>();

p5App.post('/release-batches', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: Partial<CreateReleaseBatchRequest>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const projectId = cleanText(body.projectId);
  const projectVersion = expectedVersion(body.expectedProjectVersion);
  const releaseDate = validDate(body.releaseDate);
  const note = nullableText(body.note, 1000);
  const lines = normalizeReleaseLines(body.lines);
  if (!projectId || projectVersion === null || !releaseDate || note === undefined || !lines) return c.json(apiError('INVALID_RELEASE', '出库参数无效'), 422);
  const request: CreateReleaseBatchRequest = { projectId, expectedProjectVersion: projectVersion, releaseDate, note, lines };
  const hash = await requestHash(request), operation = 'release-batches.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const project = await findProject(c.env.DB, projectId);
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (!canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权对该项目出库'), 403);
  if (project.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const scope = await loadProjectScope(c.env.DB, projectId);
  const scopeMap = new Map(scope.map((item) => [item.demand_material_id, item]));
  const released = await releasedTotals(c.env.DB, projectId);
  for (const line of lines) {
    const current = scopeMap.get(line.demandMaterialId);
    if (!current) return c.json(apiError('DEMAND_MATERIAL_NOT_IN_PROJECT', '出库范围不属于当前项目'), 422);
    const remaining = current.quantity_scaled - (released.get(line.demandMaterialId) ?? 0);
    if (line.quantityScaled > remaining) return c.json(apiError('RELEASE_EXCEEDS_ALLOCATION', '出库数量超过项目尚未出库数量', { demandMaterialId: line.demandMaterialId, remainingQuantityScaled: remaining }), 422);
  }
  const actor = c.get('currentUser'), now = new Date().toISOString(), batchId = crypto.randomUUID(), nextProjectVersion = projectVersion + 1;
  const lineRows = lines.map((line) => {
    const current = scopeMap.get(line.demandMaterialId)!;
    const snapshot: ReleaseLineSummary['snapshot'] = {
      demandId: current.demand_id,
      lineName: current.line_name,
      section: current.section_text,
      rawModel: current.raw_model,
      unit: current.unit,
      projectVersion,
      reserveVersion: project.reserve_version,
    };
    return { id: crypto.randomUUID(), input: line, snapshot };
  });
  const data: ReleaseBatchSummary = {
    id: batchId,
    projectId,
    releaseDate,
    note,
    projectVersionSnapshot: projectVersion,
    reserveVersionSnapshot: project.reserve_version,
    projectVersion: nextProjectVersion,
    lines: lineRows.map((item) => ({ id: item.id, releaseBatchId: batchId, ...item.input, snapshot: item.snapshot })),
    createdAt: now,
  };
  const response = { ok: true as const, data };
  const statements: D1PreparedStatement[] = [
    projectVersionGuard(c.env.DB, projectId, projectVersion, now),
    c.env.DB.prepare(`INSERT INTO release_batches (id,project_id,release_date,note,project_version_snapshot,reserve_version_snapshot,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`).bind(batchId, projectId, releaseDate, note, projectVersion, project.reserve_version, actor.id, now),
    ...lineRows.map((item) => c.env.DB.prepare(`INSERT INTO release_lines (id,release_batch_id,project_id,demand_material_id,quantity_scaled,snapshot_json,created_at) VALUES (?,?,?,?,?,?,?)`).bind(item.id, batchId, projectId, item.input.demandMaterialId, item.input.quantityScaled, JSON.stringify(item.snapshot), now)),
    auditStatement(c.env.DB, actor.id, 'release.create', 'release_batch', batchId, null, data, now),
    idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 201, now),
  ];
  try { await c.env.DB.batch(statements); } catch {
    const raceReplay = await replayIdempotentResponse(c, key, operation, hash); if (raceReplay) return raceReplay;
    const latest = await findProject(c.env.DB, projectId);
    if (latest && latest.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('RELEASE_CONFLICT', '出库写入冲突，请刷新后重试'), 409);
  }
  return c.json(response, 201);
});

p5App.get('/release-batches', async (c) => {
  const projectId = cleanText(c.req.query('projectId'));
  if (!projectId) return c.json(apiError('PROJECT_REQUIRED', 'projectId 不能为空'), 400);
  if (!canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目出库'), 403);
  return c.json({ ok: true as const, data: { items: await loadReleaseBatches(c.env.DB, projectId) } });
});

p5App.post('/implementations', requireRoles('admin', 'project_manager', 'implementation'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: Partial<CreateImplementationRequest>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const historical = body.historical === true;
  const projectId = body.projectId === null || body.projectId === undefined ? null : cleanText(body.projectId);
  const projectVersion = body.expectedProjectVersion === null || body.expectedProjectVersion === undefined ? null : expectedVersion(body.expectedProjectVersion);
  const recordDate = validDate(body.recordDate);
  const personnel = nullableText(body.personnel, 120);
  const note = nullableText(body.note, 1000);
  const lines = normalizeImplementationLines(body.lines);
  if (!recordDate || personnel === undefined || note === undefined || !lines) return c.json(apiError('INVALID_IMPLEMENTATION', '实施记录参数无效'), 422);
  if (historical) {
    if (projectId !== null || projectVersion !== null || lines.some((line) => line.releaseLineId !== null || !line.description)) return c.json(apiError('INVALID_HISTORICAL_IMPLEMENTATION', '未关联历史实施不能预设项目或出库范围，并需填写明细描述'), 422);
  } else if (!projectId || projectVersion === null || lines.some((line) => !line.releaseLineId)) {
    return c.json(apiError('RELEASE_SCOPE_REQUIRED', '正常实施必须关联项目版本和已出库范围'), 422);
  }
  const request: CreateImplementationRequest = { historical, projectId, expectedProjectVersion: projectVersion, recordDate, personnel, note, lines };
  const hash = await requestHash(request), operation = 'implementations.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), now = new Date().toISOString(), id = crypto.randomUUID();

  if (historical) {
    const lineRows = lines.map((line) => ({ id: crypto.randomUUID(), line }));
    const row: ImplementationRecordRow = { id, project_id: null, historical: 1, record_date: recordDate, personnel, note, version: 1, created_at: now, updated_at: now };
    const data: ImplementationRecordSummary = {
      id,
      projectId: null,
      historical: true,
      recordDate,
      personnel,
      note,
      version: 1,
      projectVersion: null,
      lines: lineRows.map((item) => ({ id: item.id, implementationId: id, projectId: null, ...item.line, releaseLineId: null, demandMaterialId: null })),
      createdAt: now,
      updatedAt: now,
    };
    const response = { ok: true as const, data };
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO implementation_records (id,project_id,historical,record_date,personnel,note,version,created_by,created_at,updated_at) VALUES (?,NULL,1,?,?,?,1,?,?,?)`).bind(id, recordDate, personnel, note, actor.id, now, now),
        ...lineRows.map((item) => c.env.DB.prepare(`INSERT INTO implementation_lines (id,implementation_id,project_id,release_line_id,demand_material_id,description,unit,completed_quantity_scaled,actual_used_quantity_scaled,created_at) VALUES (?,?,NULL,NULL,NULL,?,?,?,?,?)`).bind(item.id, id, item.line.description, item.line.unit, item.line.completedQuantityScaled, item.line.actualUsedQuantityScaled, now)),
        auditStatement(c.env.DB, actor.id, 'implementation.historical.create', 'implementation', id, null, data, now),
        idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 201, now),
      ]);
    } catch {
      const raceReplay = await replayIdempotentResponse(c, key, operation, hash); if (raceReplay) return raceReplay;
      return c.json(apiError('IMPLEMENTATION_CONFLICT', '历史实施记录写入冲突'), 409);
    }
    void row;
    return c.json(response, 201);
  }

  const project = await findProject(c.env.DB, projectId!);
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (!canProject(c, project.id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权登记该项目实施'), 403);
  if (project.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const releaseResult = await c.env.DB.prepare(
    `SELECT rl.id,rl.release_batch_id,rl.project_id,rl.demand_material_id,rl.quantity_scaled,rl.snapshot_json,rl.created_at
     FROM release_lines rl WHERE rl.project_id=?`,
  ).bind(project.id).all<ReleaseLineRow>();
  const releaseMap = new Map((releaseResult.results ?? []).map((row) => [row.id, row]));
  const usedResult = await c.env.DB.prepare(
    `SELECT release_line_id,COALESCE(SUM(completed_quantity_scaled),0) AS total
     FROM implementation_lines WHERE project_id=? AND release_line_id IS NOT NULL GROUP BY release_line_id`,
  ).bind(project.id).all<{ release_line_id: string; total: number }>();
  const used = new Map((usedResult.results ?? []).map((row) => [row.release_line_id, Number(row.total)]));
  for (const line of lines) {
    const release = releaseMap.get(line.releaseLineId!);
    if (!release) return c.json(apiError('RELEASE_LINE_NOT_FOUND', '实施明细引用的出库范围不存在'), 422);
    const remaining = release.quantity_scaled - (used.get(release.id) ?? 0);
    if (line.completedQuantityScaled > remaining) return c.json(apiError('IMPLEMENTATION_EXCEEDS_RELEASE', '实施完成量超过对应出库范围剩余量', { releaseLineId: release.id, remainingQuantityScaled: remaining }), 422);
  }
  const nextProjectVersion = projectVersion! + 1;
  const lineRows = lines.map((line) => ({ id: crypto.randomUUID(), line, release: releaseMap.get(line.releaseLineId!)! }));
  const data: ImplementationRecordSummary = {
    id,
    projectId: project.id,
    historical: false,
    recordDate,
    personnel,
    note,
    version: 1,
    projectVersion: nextProjectVersion,
    lines: lineRows.map((item) => ({ id: item.id, implementationId: id, projectId: project.id, demandMaterialId: item.release.demand_material_id, ...item.line })),
    createdAt: now,
    updatedAt: now,
  };
  const response = { ok: true as const, data };
  try {
    await c.env.DB.batch([
      projectVersionGuard(c.env.DB, project.id, projectVersion!, now),
      c.env.DB.prepare(`INSERT INTO implementation_records (id,project_id,historical,record_date,personnel,note,version,created_by,created_at,updated_at) VALUES (?,?,0,?,?,?,1,?,?,?)`).bind(id, project.id, recordDate, personnel, note, actor.id, now, now),
      ...lineRows.map((item) => c.env.DB.prepare(`INSERT INTO implementation_lines (id,implementation_id,project_id,release_line_id,demand_material_id,description,unit,completed_quantity_scaled,actual_used_quantity_scaled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(item.id, id, project.id, item.release.id, item.release.demand_material_id, item.line.description, item.line.unit, item.line.completedQuantityScaled, item.line.actualUsedQuantityScaled, now)),
      auditStatement(c.env.DB, actor.id, 'implementation.create', 'implementation', id, null, data, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 201, now),
    ]);
  } catch {
    const raceReplay = await replayIdempotentResponse(c, key, operation, hash); if (raceReplay) return raceReplay;
    const latest = await findProject(c.env.DB, project.id);
    if (latest && latest.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('IMPLEMENTATION_CONFLICT', '实施记录写入冲突'), 409);
  }
  return c.json(response, 201);
});

p5App.get('/implementations', async (c) => {
  const projectId = cleanText(c.req.query('projectId'));
  const unlinked = c.req.query('unlinked') === 'true';
  if (projectId && !canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目实施记录'), 403);
  if (!projectId && !unlinked) return c.json(apiError('PROJECT_REQUIRED', '必须指定 projectId 或 unlinked=true'), 400);
  if (unlinked && !['admin', 'project_manager', 'implementation'].includes(c.get('currentUser').role)) return c.json(apiError('FORBIDDEN', '当前角色不能查看待关联历史实施'), 403);
  const result = projectId
    ? await c.env.DB.prepare(`SELECT id,project_id,historical,record_date,personnel,note,version,created_at,updated_at FROM implementation_records WHERE project_id=? ORDER BY record_date DESC,created_at DESC,id DESC LIMIT 100`).bind(projectId).all<ImplementationRecordRow>()
    : await c.env.DB.prepare(`SELECT id,project_id,historical,record_date,personnel,note,version,created_at,updated_at FROM implementation_records WHERE historical=1 AND project_id IS NULL ORDER BY record_date DESC,created_at DESC,id DESC LIMIT 100`).all<ImplementationRecordRow>();
  const rows = result.results ?? [];
  const projectVersion = projectId && rows.length > 0 ? (await findProject(c.env.DB, projectId))?.version ?? null : null;
  return c.json({ ok: true as const, data: { items: await implementationSummaries(c.env.DB, rows, projectVersion) } });
});

p5App.put('/implementations/:id/link', requireRoles('admin', 'project_manager', 'implementation'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Partial<LinkHistoricalImplementationRequest>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const recordVersion = expectedVersion(body.expectedVersion), projectId = cleanText(body.projectId), projectVersion = expectedVersion(body.expectedProjectVersion);
  const links = Array.isArray(body.links) ? body.links as HistoricalImplementationLinkInput[] : null;
  if (recordVersion === null || !projectId || projectVersion === null || !links || links.length < 1 || links.length > MAX_LINES) return c.json(apiError('INVALID_LINK', '历史实施关联参数无效'), 422);
  const seenLines = new Set<string>();
  for (const raw of links) {
    const lineId = cleanText(raw?.implementationLineId), demandMaterialId = cleanText(raw?.demandMaterialId);
    if (!lineId || !demandMaterialId || seenLines.has(lineId)) return c.json(apiError('INVALID_LINK', '历史实施关联明细无效或重复'), 422);
    seenLines.add(lineId);
  }
  const request: LinkHistoricalImplementationRequest = { expectedVersion: recordVersion, projectId, expectedProjectVersion: projectVersion, links };
  const hash = await requestHash(request), operation = `implementations.link:${c.req.param('id')}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const record = await findImplementation(c.env.DB, c.req.param('id'));
  if (!record) return c.json(apiError('NOT_FOUND', '实施记录不存在'), 404);
  if (record.historical !== 1 || record.project_id !== null) return c.json(apiError('IMPLEMENTATION_ALREADY_LINKED', '该记录不是待关联历史实施'), 422);
  if (record.version !== recordVersion) return c.json(apiError('VERSION_CONFLICT', '实施记录已被修改，请刷新后重试'), 409);
  const project = await findProject(c.env.DB, projectId);
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (!canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权关联到该项目'), 403);
  if (project.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const recordLines = await loadImplementationLines(c.env.DB, record.id);
  if (recordLines.length !== links.length || recordLines.some((line) => !seenLines.has(line.id))) return c.json(apiError('LINK_SCOPE_INCOMPLETE', '必须一次性为全部历史实施明细指定项目需求物资'), 422);
  const scope = await loadProjectScope(c.env.DB, projectId);
  const scopeMap = new Map(scope.map((item) => [item.demand_material_id, item]));
  const implemented = await implementedTotals(c.env.DB, projectId);
  const proposed = new Map<string, number>();
  const linkMap = new Map(links.map((item) => [item.implementationLineId, item.demandMaterialId]));
  for (const line of recordLines) {
    const demandMaterialId = linkMap.get(line.id)!;
    const target = scopeMap.get(demandMaterialId);
    if (!target) return c.json(apiError('DEMAND_MATERIAL_NOT_IN_PROJECT', '历史实施关联目标不属于该项目'), 422);
    if (line.unit && target.unit && line.unit !== target.unit) return c.json(apiError('UNIT_MISMATCH', '历史实施单位与项目需求物资单位不一致'), 422);
    const next = (proposed.get(demandMaterialId) ?? 0) + line.completed_quantity_scaled;
    if (!Number.isSafeInteger(next)) return c.json(apiError('QUANTITY_OVERFLOW', '实施数量超出安全整数范围'), 422);
    proposed.set(demandMaterialId, next);
  }
  for (const [demandMaterialId, quantity] of proposed) {
    const target = scopeMap.get(demandMaterialId)!;
    const current = implemented.get(demandMaterialId) ?? 0;
    if (current + quantity > target.quantity_scaled) return c.json(apiError('IMPLEMENTATION_EXCEEDS_PROJECT', '历史实施关联后会超过项目需求物资数量'), 422);
  }
  const actor = c.get('currentUser'), now = new Date().toISOString(), nextRecordVersion = recordVersion + 1, nextProjectVersion = projectVersion + 1;
  const data: ImplementationRecordSummary = {
    id: record.id,
    projectId,
    historical: true,
    recordDate: record.record_date,
    personnel: record.personnel,
    note: record.note,
    version: nextRecordVersion,
    projectVersion: nextProjectVersion,
    lines: recordLines.map((line) => implementationLineSummary({ ...line, project_id: projectId, demand_material_id: linkMap.get(line.id)! })),
    createdAt: record.created_at,
    updatedAt: now,
  };
  const response = { ok: true as const, data };
  const recordGuard = c.env.DB.prepare(
    `UPDATE implementation_records SET project_id=?,version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END WHERE id=?`,
  ).bind(projectId, recordVersion, now, record.id);
  try {
    await c.env.DB.batch([
      projectVersionGuard(c.env.DB, projectId, projectVersion, now),
      recordGuard,
      ...recordLines.map((line) => c.env.DB.prepare(`UPDATE implementation_lines SET project_id=?,demand_material_id=? WHERE id=? AND implementation_id=?`).bind(projectId, linkMap.get(line.id)!, line.id, record.id)),
      auditStatement(c.env.DB, actor.id, 'implementation.historical.link', 'implementation', record.id, { projectId: null, version: recordVersion }, { projectId, version: nextRecordVersion }, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, now),
    ]);
  } catch {
    const raceReplay = await replayIdempotentResponse(c, key, operation, hash); if (raceReplay) return raceReplay;
    const latestProject = await findProject(c.env.DB, projectId);
    if (latestProject && latestProject.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('IMPLEMENTATION_LINK_CONFLICT', '历史实施关联冲突，请刷新后重试'), 409);
  }
  return c.json(response);
});

p5App.post('/settlements', requireRoles('admin', 'project_manager', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Partial<CreateSettlementRequest>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const projectId = cleanText(body.projectId), projectVersion = expectedVersion(body.expectedProjectVersion), settlementDate = validDate(body.settlementDate);
  const amountFen = nonNegativeInteger(body.amountFen), final = body.final === true, note = nullableText(body.note, 1000);
  const coverage = normalizeCoverage(body.coverage, final), agreementAllocations = normalizeAgreementAllocations(body.agreementAllocations);
  if (!projectId || projectVersion === null || !settlementDate || amountFen === null || note === undefined || !coverage || !agreementAllocations) return c.json(apiError('INVALID_SETTLEMENT', '结算参数无效'), 422);
  const request: CreateSettlementRequest = { projectId, expectedProjectVersion: projectVersion, settlementDate, amountFen, final, note, coverage, agreementAllocations };
  const hash = await requestHash(request), operation = 'settlements.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const project = await findProject(c.env.DB, projectId);
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (!canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权登记该项目结算'), 403);
  if (project.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const scope = await loadProjectScope(c.env.DB, projectId);
  const scopeMap = new Map(scope.map((item) => [item.demand_material_id, item]));
  const settled = await activeSettlementTotals(c.env.DB, projectId);
  const proposed = new Map<string, number>();
  for (const item of coverage) {
    const target = scopeMap.get(item.demandMaterialId);
    if (!target) return c.json(apiError('DEMAND_MATERIAL_NOT_IN_PROJECT', '结算覆盖范围不属于当前项目'), 422);
    const after = (settled.get(item.demandMaterialId) ?? 0) + item.quantityScaled;
    if (after > target.quantity_scaled) return c.json(apiError('SETTLEMENT_EXCEEDS_PROJECT', '结算覆盖数量超过项目需求物资数量'), 422);
    proposed.set(item.demandMaterialId, after);
  }
  if (final) {
    const incomplete = scope.find((item) => (proposed.get(item.demand_material_id) ?? settled.get(item.demand_material_id) ?? 0) < item.quantity_scaled);
    if (incomplete) return c.json(apiError('FINAL_SETTLEMENT_INCOMPLETE', '最终结算必须覆盖项目全部需求物资范围', { demandMaterialId: incomplete.demand_material_id }), 422);
  }
  if (agreementAllocations.length) {
    const sum = safeSum(agreementAllocations.map((item) => item.amountFen));
    if (sum === null || sum !== amountFen) return c.json(apiError('SETTLEMENT_AGREEMENT_MISMATCH', '结算协议分摊金额必须精确等于结算金额'), 422);
    if (!project.framework_id) return c.json(apiError('PROJECT_FRAMEWORK_REQUIRED', '项目未归属框架，不能填写结算协议分摊'), 422);
    for (const item of agreementAllocations) {
      const agreement = await c.env.DB.prepare(`SELECT framework_id,status,valid_from,valid_to FROM agreements WHERE id=? LIMIT 1`).bind(item.agreementId).first<{ framework_id: string; status: string; valid_from: string; valid_to: string }>();
      if (!agreement) return c.json(apiError('AGREEMENT_NOT_FOUND', '结算协议不存在'), 422);
      if (agreement.framework_id !== project.framework_id) return c.json(apiError('AGREEMENT_FRAMEWORK_MISMATCH', '结算协议与项目不属于同一框架'), 422);
      if (agreement.status !== 'active' || settlementDate < agreement.valid_from || settlementDate > agreement.valid_to) return c.json(apiError('AGREEMENT_NOT_EFFECTIVE', '结算协议在结算日期无效'), 422);
    }
  }
  const actor = c.get('currentUser'), now = new Date().toISOString(), id = crypto.randomUUID(), nextProjectVersion = projectVersion + 1;
  const data: SettlementSummary = {
    id,
    projectId,
    settlementDate,
    amountFen,
    final,
    note,
    version: 1,
    voidedAt: null,
    voidReason: null,
    projectVersion: nextProjectVersion,
    coverage,
    agreementAllocations,
    createdAt: now,
    updatedAt: now,
  };
  const response = { ok: true as const, data };
  try {
    await c.env.DB.batch([
      projectVersionGuard(c.env.DB, projectId, projectVersion, now),
      c.env.DB.prepare(`INSERT INTO settlements (id,project_id,settlement_date,amount_fen,final,note,version,voided_at,voided_by,void_reason,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,1,NULL,NULL,NULL,?,?,?)`).bind(id, projectId, settlementDate, amountFen, final ? 1 : 0, note, actor.id, now, now),
      ...coverage.map((item) => c.env.DB.prepare(`INSERT INTO settlement_coverage (id,settlement_id,project_id,demand_material_id,quantity_scaled,created_at) VALUES (?,?,?,?,?,?)`).bind(crypto.randomUUID(), id, projectId, item.demandMaterialId, item.quantityScaled, now)),
      ...agreementAllocations.map((item) => c.env.DB.prepare(`INSERT INTO settlement_agreement_allocations (id,settlement_id,agreement_id,amount_fen,created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), id, item.agreementId, item.amountFen, now)),
      auditStatement(c.env.DB, actor.id, 'settlement.create', 'settlement', id, null, data, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 201, now),
    ]);
  } catch {
    const raceReplay = await replayIdempotentResponse(c, key, operation, hash); if (raceReplay) return raceReplay;
    const latest = await findProject(c.env.DB, projectId);
    if (latest && latest.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('SETTLEMENT_CONFLICT', '结算写入冲突，请刷新后重试'), 409);
  }
  return c.json(response, 201);
});

p5App.get('/settlements', async (c) => {
  const projectId = cleanText(c.req.query('projectId'));
  if (!projectId) return c.json(apiError('PROJECT_REQUIRED', 'projectId 不能为空'), 400);
  if (!canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目结算'), 403);
  const project = await findProject(c.env.DB, projectId);
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  const result = await c.env.DB.prepare(`SELECT id,project_id,settlement_date,amount_fen,final,note,version,voided_at,void_reason,created_at,updated_at FROM settlements WHERE project_id=? ORDER BY settlement_date DESC,created_at DESC,id DESC LIMIT 100`).bind(projectId).all<SettlementRow>();
  return c.json({ ok: true as const, data: { items: await settlementSummaries(c.env.DB, result.results ?? [], project.version) } });
});

p5App.post('/settlements/:id/void', requireRoles('admin', 'project_manager', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Partial<VoidSettlementRequest>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const settlementVersion = expectedVersion(body.expectedVersion), projectVersion = expectedVersion(body.expectedProjectVersion), reason = nullableText(body.reason, 1000);
  if (settlementVersion === null || projectVersion === null || !reason) return c.json(apiError('INVALID_VOID', '撤销结算的版本和原因不能为空'), 422);
  const request: VoidSettlementRequest = { expectedVersion: settlementVersion, expectedProjectVersion: projectVersion, reason };
  const hash = await requestHash(request), operation = `settlements.void:${c.req.param('id')}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const settlement = await findSettlement(c.env.DB, c.req.param('id'));
  if (!settlement) return c.json(apiError('NOT_FOUND', '结算记录不存在'), 404);
  if (!canProject(c, settlement.project_id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权撤销该项目结算'), 403);
  if (settlement.voided_at) return c.json(apiError('SETTLEMENT_ALREADY_VOIDED', '该结算已经撤销'), 409);
  if (settlement.version !== settlementVersion) return c.json(apiError('VERSION_CONFLICT', '结算记录已被修改，请刷新后重试'), 409);
  const project = await findProject(c.env.DB, settlement.project_id);
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (project.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const actor = c.get('currentUser'), now = new Date().toISOString();
  const data = await settlementSummary(c.env.DB, { ...settlement, version: settlementVersion + 1, voided_at: now, void_reason: reason, updated_at: now }, projectVersion + 1);
  const response = { ok: true as const, data };
  const settlementGuard = c.env.DB.prepare(
    `UPDATE settlements SET voided_at=?,voided_by=?,void_reason=?,version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END WHERE id=? AND voided_at IS NULL`,
  ).bind(now, actor.id, reason, settlementVersion, now, settlement.id);
  try {
    await c.env.DB.batch([
      projectVersionGuard(c.env.DB, project.id, projectVersion, now),
      settlementGuard,
      auditStatement(c.env.DB, actor.id, 'settlement.void', 'settlement', settlement.id, { version: settlementVersion, voidedAt: null }, { version: settlementVersion + 1, voidedAt: now, reason }, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, now),
    ]);
  } catch {
    const raceReplay = await replayIdempotentResponse(c, key, operation, hash); if (raceReplay) return raceReplay;
    const latestProject = await findProject(c.env.DB, project.id);
    if (latestProject && latestProject.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('SETTLEMENT_VOID_CONFLICT', '撤销结算发生冲突'), 409);
  }
  return c.json(response);
});

p5App.get('/projects/:id/lifecycle', async (c) => {
  const project = await findProject(c.env.DB, c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (!canProject(c, project.id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目状态'), 403);
  const scope = await loadProjectScope(c.env.DB, project.id);
  const [released, implemented, settled, completionRows, finalSettlement] = await Promise.all([
    releasedTotals(c.env.DB, project.id),
    implementedTotals(c.env.DB, project.id),
    activeSettlementTotals(c.env.DB, project.id),
    c.env.DB.prepare(
      `SELECT MAX(ir.record_date) AS max_date
       FROM implementation_lines il INNER JOIN implementation_records ir ON ir.id=il.implementation_id
       WHERE il.project_id=? AND il.demand_material_id IS NOT NULL`,
    ).bind(project.id).first<{ max_date: string | null }>(),
    c.env.DB.prepare(`SELECT id FROM settlements WHERE project_id=? AND final=1 AND voided_at IS NULL ORDER BY settlement_date DESC,created_at DESC,id DESC LIMIT 1`).bind(project.id).first<{ id: string }>(),
  ]);
  const lines: LifecycleLineSummary[] = scope.map((item) => {
    const implementedQuantityScaled = implemented.get(item.demand_material_id) ?? 0;
    const settledQuantityScaled = settled.get(item.demand_material_id) ?? 0;
    const implementationComplete = implementedQuantityScaled >= item.quantity_scaled;
    const settlementComplete = finalSettlement !== null && settledQuantityScaled >= item.quantity_scaled;
    return {
      demandId: item.demand_id,
      demandMaterialId: item.demand_material_id,
      lineName: item.line_name,
      section: item.section_text,
      rawModel: item.raw_model,
      unit: item.unit,
      allocatedQuantityScaled: item.quantity_scaled,
      releasedQuantityScaled: released.get(item.demand_material_id) ?? 0,
      implementedQuantityScaled,
      settledQuantityScaled,
      implementationComplete,
      settlementComplete,
      state: lifecycleState(implementationComplete, settlementComplete),
    };
  });
  const implementationComplete = lines.length > 0 && lines.every((line) => line.implementationComplete);
  const settlementComplete = lines.length > 0 && lines.every((line) => line.settlementComplete);
  const projectState = lifecycleState(implementationComplete, settlementComplete);
  const demandMap = new Map<string, LifecycleLineSummary[]>();
  for (const line of lines) {
    const list = demandMap.get(line.demandId) ?? [];
    list.push(line);
    demandMap.set(line.demandId, list);
  }
  const demands: DemandLifecycleSummary[] = [...demandMap.entries()].map(([demandId, demandLines]) => {
    const impl = demandLines.every((line) => line.implementationComplete);
    const settle = demandLines.every((line) => line.settlementComplete);
    return { demandId, lineName: demandLines[0]!.lineName, section: demandLines[0]!.section, implementationComplete: impl, settlementComplete: settle, state: lifecycleState(impl, settle) };
  });
  const implementationCompletedDate = implementationComplete ? completionRows?.max_date ?? null : null;
  const data: ProjectLifecycleSummary = {
    projectId: project.id,
    projectVersion: project.version,
    implementationComplete,
    settlementComplete,
    projectState,
    lines,
    demands,
    settlementTodo: {
      needed: implementationComplete && !settlementComplete,
      implementationCompletedDate,
      dueDate: implementationComplete && !settlementComplete && implementationCompletedDate ? addDays(implementationCompletedDate, 30) : null,
      finalSettlementId: finalSettlement?.id ?? null,
    },
  };
  return c.json({ ok: true as const, data });
});

p5App.post('/attachments', requireRoles('admin', 'project_manager', 'implementation', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  const objectType = cleanText(c.req.query('objectType')) as AttachmentSummary['objectType'];
  const objectId = cleanText(c.req.query('objectId'));
  const fileName = cleanText(c.req.query('fileName'));
  if (!['project', 'release', 'implementation', 'settlement'].includes(objectType) || !objectId || !fileName || fileName.length > 255) return c.json(apiError('INVALID_ATTACHMENT', '附件归属或文件名无效'), 422);
  const { database, objectStore } = createCloudflarePersistence(c.env);
  const attachments = new SqlAttachmentRepository(database);
  const projectId = await attachments.resolveObjectProject(objectType, objectId);
  if (!projectId) return c.json(apiError('ATTACHMENT_OBJECT_NOT_FOUND', '附件归属对象不存在或尚未关联项目'), 404);
  if (!canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权向该项目上传附件'), 403);
  const contentType = cleanText(c.req.header('Content-Type')) || 'application/octet-stream';
  if (contentType.length > 200) return c.json(apiError('INVALID_ATTACHMENT', '附件 Content-Type 过长'), 422);
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return c.json(apiError('ATTACHMENT_TOO_LARGE', '附件最大 10 MiB'), 422);
  const contentSha256 = await bytesHash(bytes);
  const request = { objectType, objectId, fileName, contentType, sizeBytes: bytes.byteLength, contentSha256 };
  const hash = await requestHash(request), operation = 'attachments.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const actor = c.get('currentUser'), id = crypto.randomUUID(), now = new Date().toISOString(), r2Key = `attachments/${projectId}/${id}`;
  const record: AttachmentRecord = { id, projectId, objectType, objectId, storageKey: r2Key, fileName, contentType, sizeBytes: bytes.byteLength, createdAt: now };
  const data = attachmentSummary(record);
  const response = { ok: true as const, data };
  await saveAttachmentContent(objectStore, r2Key, new Uint8Array(bytes), contentType);
  try {
    await attachments.create({
      record,
      uploadedBy: actor.id,
      auditEventId: crypto.randomUUID(),
      idempotency: {
        key,
        actorId: actor.id,
        operation,
        requestHash: hash,
        responseJson: JSON.stringify(response),
        statusCode: 201,
        createdAt: now,
      },
    });
  } catch {
    await deleteAttachmentContent(objectStore, r2Key);
    const raceReplay = await replayIdempotentResponse(c, key, operation, hash); if (raceReplay) return raceReplay;
    return c.json(apiError('ATTACHMENT_CONFLICT', '附件元数据写入冲突'), 409);
  }
  return c.json(response, 201);
});

p5App.get('/attachments', async (c) => {
  const objectType = cleanText(c.req.query('objectType')) as AttachmentSummary['objectType'];
  const objectId = cleanText(c.req.query('objectId'));
  if (!['project', 'release', 'implementation', 'settlement'].includes(objectType) || !objectId) return c.json(apiError('INVALID_ATTACHMENT_QUERY', '附件查询参数无效'), 400);
  const { database } = createCloudflarePersistence(c.env);
  const attachments = new SqlAttachmentRepository(database);
  const projectId = await attachments.resolveObjectProject(objectType, objectId);
  if (!projectId) return c.json(apiError('ATTACHMENT_OBJECT_NOT_FOUND', '附件归属对象不存在或尚未关联项目'), 404);
  if (!canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目附件'), 403);
  const records = await attachments.listByObject(objectType, objectId, 100);
  return c.json({ ok: true as const, data: { items: records.map(attachmentSummary) } });
});

p5App.get('/attachments/:id/content', async (c) => {
  const { database, objectStore } = createCloudflarePersistence(c.env);
  const attachments = new SqlAttachmentRepository(database);
  const attachment = await attachments.findById(c.req.param('id'));
  if (!attachment) return c.json(apiError('NOT_FOUND', '附件不存在'), 404);
  if (!canProject(c, attachment.projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权下载该项目附件'), 403);
  const object = await loadAttachmentContent(objectStore, attachment.storageKey);
  if (!object) return c.json(apiError('ATTACHMENT_CONTENT_MISSING', '附件内容不存在'), 404);
  const headers = new Headers();
  headers.set('Content-Type', attachment.contentType);
  headers.set('Content-Length', String(attachment.sizeBytes));
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(object.bytes, { status: 200, headers });
});
