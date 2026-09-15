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
import { deleteAttachmentContent, loadAttachmentContent, saveAttachmentContent } from './application/attachment-content.ts';
import { hasScope, requireRoles, type AppEnv } from './auth.ts';
import type { AttachmentRecord } from './ports/attachment-repository';
import { SqlAttachmentRepository } from './repositories/sql-attachment-repository.ts';
import { SqlIdempotencyRepository } from './repositories/sql-idempotency-repository.ts';
import { SqlLegacyExecutionRepository } from './repositories/sql-legacy-execution-repository.ts';
import { SqlFinanceQueryRepository } from './repositories/sql-finance-query-repository.ts';
import { resolvePersistence as createCloudflarePersistence } from './runtime/persistence.ts';

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

export const projectLifecycleApp = new Hono<AppEnv>();

projectLifecycleApp.post('/release-batches', requireRoles('admin', 'project_manager'), async (c) => {
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
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlLegacyExecutionRepository(database);
  const project = await repository.findProject(projectId);
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (!canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权对该项目出库'), 403);
  if (project.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const scope = await repository.loadProjectScope(projectId);
  const scopeMap = new Map(scope.map((item) => [item.demandMaterialId, item]));
  const released = await repository.releasedTotals(projectId);
  for (const line of lines) {
    const current = scopeMap.get(line.demandMaterialId);
    if (!current) return c.json(apiError('DEMAND_MATERIAL_NOT_IN_PROJECT', '出库范围不属于当前项目'), 422);
    const remaining = current.quantityScaled - (released.get(line.demandMaterialId) ?? 0);
    if (line.quantityScaled > remaining) return c.json(apiError('RELEASE_EXCEEDS_ALLOCATION', '出库数量超过项目尚未出库数量', { demandMaterialId: line.demandMaterialId, remainingQuantityScaled: remaining }), 422);
  }
  const actor = c.get('currentUser'), now = new Date().toISOString(), batchId = crypto.randomUUID(), nextProjectVersion = projectVersion + 1;
  const lineRows = lines.map((line) => {
    const current = scopeMap.get(line.demandMaterialId)!;
    const snapshot: ReleaseLineSummary['snapshot'] = { demandId: current.demandId, lineName: current.lineName, section: current.section, rawModel: current.rawModel, unit: current.unit, projectVersion, reserveVersion: project.reserveVersion };
    return { id: crypto.randomUUID(), input: line, snapshot };
  });
  const data: ReleaseBatchSummary = { id: batchId, projectId, releaseDate, note, projectVersionSnapshot: projectVersion, reserveVersionSnapshot: project.reserveVersion, projectVersion: nextProjectVersion, lines: lineRows.map((item) => ({ id: item.id, releaseBatchId: batchId, ...item.input, snapshot: item.snapshot })), createdAt: now };
  const response = { ok: true as const, data };
  try {
    await repository.createReleaseBatch({ projectId, expectedProjectVersion: projectVersion, batch: data, meta: { actorId: actor.id, auditId: crypto.randomUUID(), idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 201, now } });
  } catch {
    const raceReplay = await replayIdempotentResponse(c, key, operation, hash); if (raceReplay) return raceReplay;
    const latest = await repository.findProject(projectId);
    if (latest && latest.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('RELEASE_CONFLICT', '出库写入冲突，请刷新后重试'), 409);
  }
  return c.json(response, 201);
});

projectLifecycleApp.get('/release-batches', async (c) => {
  const projectId = cleanText(c.req.query('projectId'));
  if (!projectId) return c.json(apiError('PROJECT_REQUIRED', 'projectId 不能为空'), 400);
  if (!canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目出库'), 403);
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlLegacyExecutionRepository(database).listReleaseBatches(projectId) } });
});

projectLifecycleApp.post('/implementations', requireRoles('admin', 'project_manager', 'implementation'), async (c) => {
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
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlLegacyExecutionRepository(database);

  if (historical) {
    const lineRows = lines.map((line) => ({ id: crypto.randomUUID(), line }));
    const data: ImplementationRecordSummary = { id, projectId: null, historical: true, recordDate, personnel, note, version: 1, projectVersion: null, lines: lineRows.map((item) => ({ id: item.id, implementationId: id, projectId: null, ...item.line, releaseLineId: null, demandMaterialId: null })), createdAt: now, updatedAt: now };
    const response = { ok: true as const, data };
    try {
      await repository.createHistoricalImplementation({ summary: data, meta: { actorId: actor.id, auditId: crypto.randomUUID(), idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 201, now } });
    } catch {
      const raceReplay = await replayIdempotentResponse(c, key, operation, hash); if (raceReplay) return raceReplay;
      return c.json(apiError('IMPLEMENTATION_CONFLICT', '历史实施记录写入冲突'), 409);
    }
    return c.json(response, 201);
  }

  const project = await repository.findProject(projectId!);
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (!canProject(c, project.id)) return c.json(apiError('SCOPE_FORBIDDEN', '无权登记该项目实施'), 403);
  if (project.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const releaseRows = await repository.findReleaseLines(project.id);
  const releaseMap = new Map(releaseRows.map((row) => [row.id, row]));
  const used = await repository.implementedReleaseTotals(project.id);
  for (const line of lines) {
    const release = releaseMap.get(line.releaseLineId!);
    if (!release) return c.json(apiError('RELEASE_LINE_NOT_FOUND', '实施明细引用的出库范围不存在'), 422);
    const remaining = release.quantityScaled - (used.get(release.id) ?? 0);
    if (line.completedQuantityScaled > remaining) return c.json(apiError('IMPLEMENTATION_EXCEEDS_RELEASE', '实施完成量超过对应出库范围剩余量', { releaseLineId: release.id, remainingQuantityScaled: remaining }), 422);
  }
  const nextProjectVersion = projectVersion! + 1;
  const lineRows = lines.map((line) => ({ id: crypto.randomUUID(), line, release: releaseMap.get(line.releaseLineId!)! }));
  const data: ImplementationRecordSummary = { id, projectId: project.id, historical: false, recordDate, personnel, note, version: 1, projectVersion: nextProjectVersion, lines: lineRows.map((item) => ({ id: item.id, implementationId: id, projectId: project.id, demandMaterialId: item.release.demandMaterialId, ...item.line })), createdAt: now, updatedAt: now };
  const response = { ok: true as const, data };
  try {
    await repository.createImplementation({ expectedProjectVersion: projectVersion!, summary: data, meta: { actorId: actor.id, auditId: crypto.randomUUID(), idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 201, now } });
  } catch {
    const raceReplay = await replayIdempotentResponse(c, key, operation, hash); if (raceReplay) return raceReplay;
    const latest = await repository.findProject(project.id);
    if (latest && latest.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('IMPLEMENTATION_CONFLICT', '实施记录写入冲突'), 409);
  }
  return c.json(response, 201);
});

projectLifecycleApp.get('/implementations', async (c) => {
  const projectId = cleanText(c.req.query('projectId'));
  const unlinked = c.req.query('unlinked') === 'true';
  if (projectId && !canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目实施记录'), 403);
  if (!projectId && !unlinked) return c.json(apiError('PROJECT_REQUIRED', '必须指定 projectId 或 unlinked=true'), 400);
  if (unlinked && !['admin', 'project_manager', 'implementation'].includes(c.get('currentUser').role)) return c.json(apiError('FORBIDDEN', '当前角色不能查看待关联历史实施'), 403);
  const { database } = createCloudflarePersistence(c.env);
  const items = await new SqlLegacyExecutionRepository(database).listImplementations({ projectId: projectId || null, unlinked });
  return c.json({ ok: true as const, data: { items } });
});

projectLifecycleApp.put('/implementations/:id/link', requireRoles('admin', 'project_manager', 'implementation'), async (c) => {
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
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlLegacyExecutionRepository(database);
  const record = await repository.findImplementation(c.req.param('id'));
  if (!record) return c.json(apiError('NOT_FOUND', '实施记录不存在'), 404);
  if (!record.summary.historical || record.summary.projectId !== null) return c.json(apiError('IMPLEMENTATION_ALREADY_LINKED', '该记录不是待关联历史实施'), 422);
  if (record.summary.version !== recordVersion) return c.json(apiError('VERSION_CONFLICT', '实施记录已被修改，请刷新后重试'), 409);
  const project = await repository.findProject(projectId);
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (!canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权关联到该项目'), 403);
  if (project.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const recordLines = record.rawLines;
  if (recordLines.length !== links.length || recordLines.some((line) => !seenLines.has(line.id))) return c.json(apiError('LINK_SCOPE_INCOMPLETE', '必须一次性为全部历史实施明细指定项目需求物资'), 422);
  const scope = await repository.loadProjectScope(projectId);
  const scopeMap = new Map(scope.map((item) => [item.demandMaterialId, item]));
  const implemented = await repository.implementedTotals(projectId);
  const proposed = new Map<string, number>();
  const linkMap = new Map(links.map((item) => [item.implementationLineId, item.demandMaterialId]));
  for (const line of recordLines) {
    const demandMaterialId = linkMap.get(line.id)!;
    const target = scopeMap.get(demandMaterialId);
    if (!target) return c.json(apiError('DEMAND_MATERIAL_NOT_IN_PROJECT', '历史实施关联目标不属于该项目'), 422);
    if (line.unit && target.unit && line.unit !== target.unit) return c.json(apiError('UNIT_MISMATCH', '历史实施单位与项目需求物资单位不一致'), 422);
    const next = (proposed.get(demandMaterialId) ?? 0) + line.completedQuantityScaled;
    if (!Number.isSafeInteger(next)) return c.json(apiError('QUANTITY_OVERFLOW', '实施数量超出安全整数范围'), 422);
    proposed.set(demandMaterialId, next);
  }
  for (const [demandMaterialId, quantity] of proposed) {
    const target = scopeMap.get(demandMaterialId)!;
    const current = implemented.get(demandMaterialId) ?? 0;
    if (current + quantity > target.quantityScaled) return c.json(apiError('IMPLEMENTATION_EXCEEDS_PROJECT', '历史实施关联后会超过项目需求物资数量'), 422);
  }
  const actor = c.get('currentUser'), now = new Date().toISOString(), nextRecordVersion = recordVersion + 1, nextProjectVersion = projectVersion + 1;
  const data: ImplementationRecordSummary = {
    ...record.summary,
    projectId,
    version: nextRecordVersion,
    projectVersion: nextProjectVersion,
    lines: recordLines.map((line) => ({ id: line.id, implementationId: record.summary.id, projectId, releaseLineId: line.releaseLineId, demandMaterialId: linkMap.get(line.id)!, description: line.description, unit: line.unit, completedQuantityScaled: line.completedQuantityScaled, actualUsedQuantityScaled: line.actualUsedQuantityScaled })),
    updatedAt: now,
  };
  const response = { ok: true as const, data };
  try {
    await repository.linkHistoricalImplementation({ expectedProjectVersion: projectVersion, expectedRecordVersion: recordVersion, summary: data, meta: { actorId: actor.id, auditId: crypto.randomUUID(), idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 200, now } });
  } catch {
    const raceReplay = await replayIdempotentResponse(c, key, operation, hash); if (raceReplay) return raceReplay;
    const latestProject = await repository.findProject(projectId);
    if (latestProject && latestProject.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('IMPLEMENTATION_LINK_CONFLICT', '历史实施关联冲突，请刷新后重试'), 409);
  }
  return c.json(response);
});

projectLifecycleApp.post('/settlements', requireRoles('admin', 'project_manager', 'finance'), async (c) => {
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
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlLegacyExecutionRepository(database);
  const project = await repository.findProject(projectId);
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (!canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权登记该项目结算'), 403);
  if (project.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const scope = await repository.loadProjectScope(projectId);
  const scopeMap = new Map(scope.map((item) => [item.demandMaterialId, item]));
  const settled = await repository.activeSettlementTotals(projectId);
  const proposed = new Map<string, number>();
  for (const item of coverage) {
    const target = scopeMap.get(item.demandMaterialId);
    if (!target) return c.json(apiError('DEMAND_MATERIAL_NOT_IN_PROJECT', '结算覆盖范围不属于当前项目'), 422);
    const after = (settled.get(item.demandMaterialId) ?? 0) + item.quantityScaled;
    if (after > target.quantityScaled) return c.json(apiError('SETTLEMENT_EXCEEDS_PROJECT', '结算覆盖数量超过项目需求物资数量'), 422);
    proposed.set(item.demandMaterialId, after);
  }
  if (final) {
    const incomplete = scope.find((item) => (proposed.get(item.demandMaterialId) ?? settled.get(item.demandMaterialId) ?? 0) < item.quantityScaled);
    if (incomplete) return c.json(apiError('FINAL_SETTLEMENT_INCOMPLETE', '最终结算必须覆盖项目全部需求物资范围', { demandMaterialId: incomplete.demandMaterialId }), 422);
  }
  if (agreementAllocations.length) {
    const sum = safeSum(agreementAllocations.map((item) => item.amountFen));
    if (sum === null || sum !== amountFen) return c.json(apiError('SETTLEMENT_AGREEMENT_MISMATCH', '结算协议分摊金额必须精确等于结算金额'), 422);
    if (!project.frameworkId) return c.json(apiError('PROJECT_FRAMEWORK_REQUIRED', '项目未归属框架，不能填写结算协议分摊'), 422);
    const validation = await new SqlFinanceQueryRepository(database).validateAgreementAllocations(project.frameworkId, agreementAllocations, settlementDate, true);
    if (!validation.ok) {
      if (validation.reason === 'not_found') return c.json(apiError('AGREEMENT_NOT_FOUND', '结算协议不存在'), 422);
      if (validation.reason === 'framework_mismatch') return c.json(apiError('AGREEMENT_FRAMEWORK_MISMATCH', '结算协议与项目不属于同一框架'), 422);
      return c.json(apiError('AGREEMENT_NOT_EFFECTIVE', '结算协议在结算日期无效'), 422);
    }
  }
  const actor = c.get('currentUser'), now = new Date().toISOString(), id = crypto.randomUUID(), nextProjectVersion = projectVersion + 1;
  const data: SettlementSummary = { id, projectId, settlementDate, amountFen, final, note, version: 1, voidedAt: null, voidReason: null, projectVersion: nextProjectVersion, coverage, agreementAllocations, createdAt: now, updatedAt: now };
  const response = { ok: true as const, data };
  try {
    await repository.createSettlement({ expectedProjectVersion: projectVersion, summary: data, meta: { actorId: actor.id, auditId: crypto.randomUUID(), idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 201, now } });
  } catch {
    const raceReplay = await replayIdempotentResponse(c, key, operation, hash); if (raceReplay) return raceReplay;
    const latest = await repository.findProject(projectId);
    if (latest && latest.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('SETTLEMENT_CONFLICT', '结算写入冲突，请刷新后重试'), 409);
  }
  return c.json(response, 201);
});

projectLifecycleApp.get('/settlements', async (c) => {
  const projectId = cleanText(c.req.query('projectId'));
  if (!projectId) return c.json(apiError('PROJECT_REQUIRED', 'projectId 不能为空'), 400);
  if (!canProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目结算'), 403);
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlLegacyExecutionRepository(database);
  if (!await repository.findProject(projectId)) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  return c.json({ ok: true as const, data: { items: await repository.listSettlements(projectId) } });
});

projectLifecycleApp.post('/settlements/:id/void', requireRoles('admin', 'project_manager', 'finance'), async (c) => {
  const key = requireIdempotencyKey(c); if (key instanceof Response) return key;
  let body: Partial<VoidSettlementRequest>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const settlementVersion = expectedVersion(body.expectedVersion), projectVersion = expectedVersion(body.expectedProjectVersion), reason = nullableText(body.reason, 1000);
  if (settlementVersion === null || projectVersion === null || !reason) return c.json(apiError('INVALID_VOID', '撤销结算的版本和原因不能为空'), 422);
  const request: VoidSettlementRequest = { expectedVersion: settlementVersion, expectedProjectVersion: projectVersion, reason };
  const hash = await requestHash(request), operation = `settlements.void:${c.req.param('id')}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash); if (replay) return replay;
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlLegacyExecutionRepository(database);
  const settlement = await repository.findSettlement(c.req.param('id'));
  if (!settlement) return c.json(apiError('NOT_FOUND', '结算记录不存在'), 404);
  if (!canProject(c, settlement.projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权撤销该项目结算'), 403);
  if (settlement.voidedAt) return c.json(apiError('SETTLEMENT_ALREADY_VOIDED', '该结算已经撤销'), 409);
  if (settlement.version !== settlementVersion) return c.json(apiError('VERSION_CONFLICT', '结算记录已被修改，请刷新后重试'), 409);
  const project = await repository.findProject(settlement.projectId);
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (project.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const actor = c.get('currentUser'), now = new Date().toISOString();
  const data: SettlementSummary = { ...settlement.summary, version: settlementVersion + 1, voidedAt: now, voidReason: reason, projectVersion: projectVersion + 1, updatedAt: now };
  const response = { ok: true as const, data };
  try {
    await repository.voidSettlement({ expectedProjectVersion: projectVersion, expectedSettlementVersion: settlementVersion, summary: data, reason, meta: { actorId: actor.id, auditId: crypto.randomUUID(), idempotencyKey: key, operation, requestHash: hash, responseJson: JSON.stringify(response), statusCode: 200, now } });
  } catch {
    const raceReplay = await replayIdempotentResponse(c, key, operation, hash); if (raceReplay) return raceReplay;
    const latestProject = await repository.findProject(project.id);
    if (latestProject && latestProject.version !== projectVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('SETTLEMENT_VOID_CONFLICT', '撤销结算发生冲突'), 409);
  }
  return c.json(response);
});

projectLifecycleApp.get('/projects/:id/lifecycle', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlLegacyExecutionRepository(database);
  const data = await repository.lifecycle(c.req.param('id'));
  if (!data) return c.json(apiError('PROJECT_NOT_FOUND', '项目不存在'), 404);
  if (!canProject(c, data.projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '无权查看该项目状态'), 403);
  return c.json({ ok: true as const, data });
});

projectLifecycleApp.post('/attachments', requireRoles('admin', 'project_manager', 'implementation', 'finance'), async (c) => {
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

projectLifecycleApp.get('/attachments', async (c) => {
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

projectLifecycleApp.get('/attachments/:id/content', async (c) => {
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
