import { Hono, type Context } from 'hono';
import type {
  ApiError,
  CategoryMappingSummary,
  ConfirmProjectRequest,
  CreateProjectRequest,
  FixedCostInput,
  MaterialPriceInput,
  MaterialSummary,
  ProjectAllocationDetail,
  ProjectCategorySummary,
  ProjectCostLine,
  ProjectCostSummary,
  ProjectDetail,
  ProjectMaterialSummary,
  ProjectSummary,
  ReplaceCategoryAllocationsRequest,
  ReplaceProjectAllocationsRequest,
  ReplaceProjectCostsRequest,
  ReserveCategorySummary,
} from '@tpm/shared';
import { hasScope, requireRoles, type AppEnv } from './auth';
import { SqlIdempotencyRepository } from './repositories/sql-idempotency-repository';
import { SqlProjectQueryRepository } from './repositories/sql-project-query-repository';
import { createCloudflarePersistence } from './runtime/cloudflare/persistence';

const MAX_PROJECT_ALLOCATIONS = 100;
const MAX_PAGE_SIZE = 100;

interface ProjectRow {
  id: string;
  name: string;
  business_year: number | null;
  owner: string | null;
  status: 'draft' | 'confirmed';
  reserve_version: number;
  framework_id: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface AllocationRow {
  id: string;
  project_id: string;
  demand_material_id: string;
  quantity_scaled: number;
  raw_model: string;
  unit: string | null;
  material_id: string | null;
  material_code: string | null;
  material_name: string | null;
  material_model: string | null;
  material_unit: string | null;
  material_enabled: number | null;
  material_version: number | null;
  demand_id: string;
  sequence_no: string;
  business_year: number | null;
  category_key: string | null;
  voltage_raw: string;
  voltage_verified: string | null;
  line_name: string;
  section_text: string;
  source_type: 'import' | 'manual';
  source_file_name: string | null;
  source_sheet: string | null;
  source_row_number: number | null;
}

interface CostLineRow {
  id: string;
  project_id: string;
  kind: 'material' | 'construction' | 'other';
  demand_allocation_id: string | null;
  label: string;
  unit_price_scaled: number | null;
  amount_fen: number | null;
  price_source: string | null;
  price_date: string | null;
  tax_inclusive: number | null;
  suggested_reserve_category_id: string | null;
}

interface CategoryRow {
  id: string;
  category_key: string;
  label: string;
  enabled: number;
  version: number;
}

interface MappingRow {
  id: string;
  demand_category_key: string;
  reserve_category_id: string;
  version: number;
}

function apiError(code: string, message: string, details?: unknown): ApiError {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function cleanText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function requireIdempotencyKey(c: Context<AppEnv>): string | Response {
  const key = c.req.header('Idempotency-Key')?.trim();
  if (!key || key.length > 200) return c.json(apiError('IDEMPOTENCY_KEY_REQUIRED', '变更请求必须提供有效的 Idempotency-Key'), 400);
  return key;
}

async function requestHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
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

function parseExpectedVersion(value: unknown): number | null {
  const version = Number(value);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

function validYear(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return undefined;
  return year;
}

function validDate(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const date = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  return date;
}

function safeNonNegativeInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function safePositiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function materialSummary(row: {
  material_id: string | null;
  material_code: string | null;
  material_name: string | null;
  material_model: string | null;
  material_unit: string | null;
  material_enabled: number | null;
  material_version: number | null;
}): MaterialSummary | null {
  if (!row.material_id || !row.material_name || !row.material_model || !row.material_unit || row.material_version === null) return null;
  return {
    id: row.material_id,
    code: row.material_code,
    name: row.material_name,
    model: row.material_model,
    unit: row.material_unit,
    enabled: row.material_enabled === 1,
    version: row.material_version,
  };
}

function costSummary(costLines: CostLineRow[], allocationCount: number): ProjectCostSummary {
  let knownAmountFen = 0;
  let pricedMaterialCount = 0;
  for (const line of costLines) {
    if (line.amount_fen !== null) knownAmountFen += line.amount_fen;
    if (line.kind === 'material' && line.unit_price_scaled !== null) pricedMaterialCount += 1;
  }
  const missingPriceCount = Math.max(0, allocationCount - pricedMaterialCount);
  const completenessBasisPoints = allocationCount === 0
    ? 0
    : Math.floor(((allocationCount - missingPriceCount) * 10000) / allocationCount);
  return { knownAmountFen, missingPriceCount, completenessBasisPoints };
}

function projectSummary(row: ProjectRow, summary: ProjectCostSummary): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    year: row.business_year,
    owner: row.owner,
    status: row.status,
    reserveVersion: row.reserve_version,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...summary,
  };
}

function parseCursor(value: string | undefined): { createdAt: string; id: string } | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))) as { createdAt?: unknown; id?: unknown };
    if (typeof decoded.createdAt !== 'string' || typeof decoded.id !== 'string') return null;
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    return null;
  }
}

function makeCursor(createdAt: string, id: string) {
  return btoa(JSON.stringify({ createdAt, id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseCandidateCursor(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))) as { id?: unknown };
    return typeof decoded.id === 'string' && decoded.id ? decoded.id : null;
  } catch {
    return null;
  }
}

function makeCandidateCursor(id: string) {
  return btoa(JSON.stringify({ id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function findProject(db: D1Database, id: string) {
  return db.prepare(
    `SELECT id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at
     FROM projects WHERE id=? LIMIT 1`,
  ).bind(id).first<ProjectRow>();
}

function canAccessProject(c: Context<AppEnv>, projectId: string) {
  const user = c.get('currentUser');
  return user.role === 'admin' || hasScope(user.scopes, 'project', projectId);
}

async function loadAllocationRows(db: D1Database, projectId: string) {
  const result = await db.prepare(
    `SELECT da.id,da.project_id,da.demand_material_id,da.quantity_scaled,
            dm.raw_model,dm.unit,
            m.id AS material_id,m.code AS material_code,m.name AS material_name,m.model AS material_model,
            m.unit AS material_unit,m.enabled AS material_enabled,m.version AS material_version,
            d.id AS demand_id,d.sequence_no,d.business_year,d.category_key,d.voltage_raw,d.voltage_verified,
            d.line_name,d.section_text,d.source_type,d.source_file_name,d.source_sheet,d.source_row_number
     FROM demand_allocations da
     INNER JOIN demand_materials dm ON dm.id=da.demand_material_id
     INNER JOIN demands d ON d.id=dm.demand_id
     LEFT JOIN materials m ON m.id=dm.material_id
     WHERE da.project_id=?
     ORDER BY d.source_file_name,d.source_sheet,d.source_row_number,da.id`,
  ).bind(projectId).all<AllocationRow>();
  return result.results ?? [];
}

async function loadCostRows(db: D1Database, projectId: string) {
  const result = await db.prepare(
    `SELECT pcl.id,pcl.project_id,pcl.kind,pcl.demand_allocation_id,pcl.label,pcl.unit_price_scaled,pcl.amount_fen,
            pcl.price_source,pcl.price_date,pcl.tax_inclusive,
            cm.reserve_category_id AS suggested_reserve_category_id
     FROM project_cost_lines pcl
     LEFT JOIN demand_allocations da ON da.id=pcl.demand_allocation_id
     LEFT JOIN demand_materials dm ON dm.id=da.demand_material_id
     LEFT JOIN demands d ON d.id=dm.demand_id
     LEFT JOIN category_mappings cm ON cm.demand_category_key=d.category_key COLLATE NOCASE
     WHERE pcl.project_id=?
     ORDER BY CASE pcl.kind WHEN 'material' THEN 1 WHEN 'construction' THEN 2 ELSE 3 END,pcl.id`,
  ).bind(projectId).all<CostLineRow>();
  return result.results ?? [];
}

function allocationDetail(row: AllocationRow): ProjectAllocationDetail {
  return {
    id: row.id,
    demandMaterialId: row.demand_material_id,
    quantityScaled: row.quantity_scaled,
    rawModel: row.raw_model,
    unit: row.unit,
    material: materialSummary(row),
    demand: {
      id: row.demand_id,
      sequenceNo: row.sequence_no,
      year: row.business_year,
      category: row.category_key,
      voltage: row.voltage_verified ?? row.voltage_raw,
      lineName: row.line_name,
      section: row.section_text,
    },
    source: row.source_type === 'manual'
      ? { type: 'manual' }
      : { type: 'import', fileName: row.source_file_name!, sheetName: row.source_sheet!, rowNumber: row.source_row_number! },
  };
}

function materialSummaryForAllocations(rows: AllocationRow[]): ProjectMaterialSummary[] {
  const groups = new Map<string, ProjectMaterialSummary>();
  for (const row of rows) {
    const material = materialSummary(row);
    const model = material?.model ?? row.raw_model;
    const unit = material?.unit ?? row.unit;
    const key = `${material?.id ?? `raw:${model.toLowerCase()}`}\u0000${(unit ?? '').toLowerCase()}`;
    const current = groups.get(key);
    if (current) current.quantityScaled += row.quantity_scaled;
    else groups.set(key, {
      materialId: material?.id ?? null,
      rawModel: row.raw_model,
      model,
      name: material?.name ?? null,
      unit,
      quantityScaled: row.quantity_scaled,
    });
  }
  return [...groups.values()].sort((a, b) => `${a.model}\u0000${a.unit ?? ''}`.localeCompare(`${b.model}\u0000${b.unit ?? ''}`, 'zh-CN'));
}

function costLineSummary(row: CostLineRow): ProjectCostLine {
  return {
    id: row.id,
    kind: row.kind,
    demandAllocationId: row.demand_allocation_id,
    label: row.label,
    unitPriceScaled: row.unit_price_scaled,
    amountFen: row.amount_fen,
    source: row.price_source,
    priceDate: row.price_date,
    taxInclusive: row.tax_inclusive === null ? null : row.tax_inclusive === 1,
    suggestedReserveCategoryId: row.suggested_reserve_category_id,
  };
}

async function fetchProjectDetail(db: D1Database, id: string): Promise<ProjectDetail | null> {
  const project = await findProject(db, id);
  if (!project) return null;
  const allocations = await loadAllocationRows(db, id);
  const costs = await loadCostRows(db, id);
  const summary = costSummary(costs, allocations.length);
  const categoryAllocationResult = await db.prepare(
    `SELECT id,cost_line_id,reserve_category_id,amount_fen
     FROM category_cost_allocations WHERE project_id=? ORDER BY cost_line_id,reserve_category_id`,
  ).bind(id).all<{ id: string; cost_line_id: string; reserve_category_id: string; amount_fen: number }>();
  const categoryAllocations = (categoryAllocationResult.results ?? []).map((row) => ({
    id: row.id,
    costLineId: row.cost_line_id,
    reserveCategoryId: row.reserve_category_id,
    amountFen: row.amount_fen,
  }));
  const categoryResult = await db.prepare(
    `SELECT rc.id AS reserve_category_id,rc.category_key,rc.label,COALESCE(SUM(cca.amount_fen),0) AS amount_fen
     FROM category_cost_allocations cca
     INNER JOIN reserve_categories rc ON rc.id=cca.reserve_category_id
     WHERE cca.project_id=?
     GROUP BY rc.id,rc.category_key,rc.label
     ORDER BY rc.label COLLATE NOCASE,rc.id`,
  ).bind(id).all<{ reserve_category_id: string; category_key: string; label: string; amount_fen: number }>();
  const categories: ProjectCategorySummary[] = (categoryResult.results ?? []).map((row) => ({
    reserveCategoryId: row.reserve_category_id,
    key: row.category_key,
    label: row.label,
    amountFen: Number(row.amount_fen),
  }));
  const classifiedAmountFen = categories.reduce((sum, item) => sum + item.amountFen, 0);
  return {
    ...projectSummary(project, summary),
    allocations: allocations.map(allocationDetail),
    materialSummary: materialSummaryForAllocations(allocations),
    costLines: costs.map(costLineSummary),
    categoryAllocations,
    categories,
    classifiedAmountFen,
    unclassifiedAmountFen: Math.max(0, summary.knownAmountFen - classifiedAmountFen),
  };
}

function validateAllocationInput(value: unknown): CreateProjectRequest['allocations'] | null {
  if (!Array.isArray(value) || value.length > MAX_PROJECT_ALLOCATIONS) return null;
  const seen = new Set<string>();
  const allocations: CreateProjectRequest['allocations'] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const candidate = item as { demandMaterialId?: unknown; quantityScaled?: unknown };
    const demandMaterialId = cleanText(candidate.demandMaterialId);
    const quantityScaled = safePositiveInteger(candidate.quantityScaled);
    if (!demandMaterialId || quantityScaled === null || seen.has(demandMaterialId)) return null;
    seen.add(demandMaterialId);
    allocations.push({ demandMaterialId, quantityScaled });
  }
  return allocations;
}

function allocationInsertStatement(
  db: D1Database,
  projectId: string,
  allocationId: string,
  demandMaterialId: string,
  quantityScaled: number,
  now: string,
) {
  return db.prepare(
    `INSERT INTO demand_allocations (id,project_id,demand_material_id,quantity_scaled,created_at)
     VALUES (
       ?,?,
       (SELECT dm.id
        FROM demand_materials dm
        WHERE dm.id=?
          AND dm.quantity_scaled >= COALESCE((
            SELECT SUM(da.quantity_scaled) FROM demand_allocations da WHERE da.demand_material_id=dm.id
          ),0) + ?),
       ?,?
     )`,
  ).bind(allocationId, projectId, demandMaterialId, quantityScaled, quantityScaled, now);
}

async function allocationFailure(db: D1Database, allocations: CreateProjectRequest['allocations']) {
  for (const allocation of allocations) {
    const row = await db.prepare(
      `SELECT dm.quantity_scaled AS original_quantity_scaled,
              COALESCE(SUM(da.quantity_scaled),0) AS allocated_quantity_scaled
       FROM demand_materials dm
       LEFT JOIN demand_allocations da ON da.demand_material_id=dm.id
       WHERE dm.id=? GROUP BY dm.id,dm.quantity_scaled`,
    ).bind(allocation.demandMaterialId).first<{ original_quantity_scaled: number; allocated_quantity_scaled: number }>();
    if (!row) return { status: 404 as const, code: 'DEMAND_MATERIAL_NOT_FOUND', message: '需求物资不存在' };
    const remaining = row.original_quantity_scaled - Number(row.allocated_quantity_scaled ?? 0);
    if (remaining < allocation.quantityScaled) {
      return {
        status: 422 as const,
        code: 'ALLOCATION_EXCEEDS_REMAINING',
        message: '分配数量超过需求物资剩余数量',
        details: { demandMaterialId: allocation.demandMaterialId, remainingQuantityScaled: remaining },
      };
    }
  }
  return null;
}

async function protectedProjectScope(db: D1Database, projectId: string) {
  const result = await db.prepare(
    `SELECT demand_material_id,MAX(total) AS protected_quantity_scaled
     FROM (
       SELECT demand_material_id,COALESCE(SUM(quantity_scaled),0) AS total
       FROM release_lines WHERE project_id=? GROUP BY demand_material_id
       UNION ALL
       SELECT demand_material_id,COALESCE(SUM(completed_quantity_scaled),0) AS total
       FROM implementation_lines WHERE project_id=? AND demand_material_id IS NOT NULL GROUP BY demand_material_id
       UNION ALL
       SELECT sc.demand_material_id,COALESCE(SUM(sc.quantity_scaled),0) AS total
       FROM settlement_coverage sc INNER JOIN settlements s ON s.id=sc.settlement_id
       WHERE sc.project_id=? AND s.voided_at IS NULL GROUP BY sc.demand_material_id
     ) protected
     GROUP BY demand_material_id`,
  ).bind(projectId, projectId, projectId).all<{ demand_material_id: string; protected_quantity_scaled: number }>();
  return new Map((result.results ?? []).map((row) => [row.demand_material_id, Number(row.protected_quantity_scaled)]));
}

function calculateAmountFen(quantityScaled: number, unitPriceScaled: number): number | null {
  const product = BigInt(quantityScaled) * BigInt(unitPriceScaled);
  const rounded = (product + 500_000n) / 1_000_000n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(rounded);
}

function projectVersionGuard(db: D1Database, projectId: string, expectedVersion: number, now: string, status: 'draft' | 'confirmed', reserveIncrement = false) {
  return db.prepare(
    `UPDATE projects
     SET status=?,
         reserve_version=reserve_version+?,
         version=version+1,
         updated_at=CASE WHEN version=? THEN ? ELSE NULL END
     WHERE id=?`,
  ).bind(status, reserveIncrement ? 1 : 0, expectedVersion, now, projectId);
}

function idempotencyStatement(
  db: D1Database,
  key: string,
  actorId: string,
  operation: string,
  hash: string,
  response: unknown,
  statusCode: number,
  now: string,
) {
  return db.prepare(
    `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(key, actorId, operation, hash, JSON.stringify(response), statusCode, now);
}

function auditStatement(
  db: D1Database,
  actorId: string,
  action: string,
  objectType: string,
  objectId: string,
  before: unknown,
  after: unknown,
  now: string,
) {
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

function categorySummary(row: CategoryRow): ReserveCategorySummary {
  return { id: row.id, key: row.category_key, label: row.label, enabled: row.enabled === 1, version: row.version };
}

function mappingSummary(row: MappingRow): CategoryMappingSummary {
  return { id: row.id, demandCategory: row.demand_category_key, reserveCategoryId: row.reserve_category_id, version: row.version };
}

export const p3App = new Hono<AppEnv>();

p3App.get('/projects/candidates', async (c) => {
  const limit = Number(c.req.query('limit') ?? '50');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return c.json(apiError('INVALID_PAGE_LIMIT', 'limit 必须在 1 到 100 之间'), 400);
  const cursorParam = c.req.query('cursor');
  const cursor = parseCandidateCursor(cursorParam);
  if (cursorParam && !cursor) return c.json(apiError('INVALID_CURSOR', '候选需求分页游标无效'), 400);
  const { database } = createCloudflarePersistence(c.env);
  const page = await new SqlProjectQueryRepository(database).listCandidates({ limit, cursor });
  return c.json({ ok: true as const, data: { items: page.items, nextCursor: page.nextCursor ? makeCandidateCursor(page.nextCursor) : null } });
});

p3App.get('/projects/suggestions', async (c) => {
  const limit = Number(c.req.query('limit') ?? '50');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return c.json(apiError('INVALID_PAGE_LIMIT', 'limit 必须在 1 到 100 之间'), 400);
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlProjectQueryRepository(database).listSuggestions(limit) } });
});

p3App.post('/projects', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: Partial<CreateProjectRequest>;
  try { body = await c.req.json<Partial<CreateProjectRequest>>(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const name = cleanText(body.name);
  const year = validYear(body.year);
  const owner = body.owner === null || body.owner === undefined ? null : cleanText(body.owner);
  const allocations = validateAllocationInput(body.allocations);
  if (!name || name.length > 120 || year === undefined || (owner !== null && owner.length > 80) || !allocations) {
    return c.json(apiError('INVALID_PROJECT', '项目名称、年度、负责人或分配明细无效'), 422);
  }
  const actor = c.get('currentUser');
  if (actor.role !== 'admin' && !actor.scopes.some((scope) => scope.type === 'all')) {
    return c.json(apiError('SCOPE_FORBIDDEN', '当前项目管理成员没有创建新项目的全局范围'), 403);
  }
  const requestBody: CreateProjectRequest = { name, year, owner, allocations };
  const hash = await requestHash(requestBody);
  const operation = 'projects.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const response = {
    ok: true as const,
    data: {
      id,
      name,
      year,
      owner,
      status: 'draft' as const,
      reserveVersion: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
      knownAmountFen: 0,
      missingPriceCount: allocations.length,
      completenessBasisPoints: 0,
    } satisfies ProjectSummary,
  };
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO projects (id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at)
       VALUES (?,?,?,?,'draft',0,NULL,1,?,?,?)`,
    ).bind(id, name, year, owner, actor.id, now, now),
  ];
  for (const allocation of allocations) {
    statements.push(allocationInsertStatement(c.env.DB, id, crypto.randomUUID(), allocation.demandMaterialId, allocation.quantityScaled, now));
  }
  statements.push(
    auditStatement(c.env.DB, actor.id, 'project.create', 'project', id, null, response.data, now),
    idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 201, now),
  );
  try {
    await c.env.DB.batch(statements);
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    const failure = await allocationFailure(c.env.DB, allocations);
    if (failure) return c.json(apiError(failure.code, failure.message, 'details' in failure ? failure.details : undefined), failure.status);
    return c.json(apiError('PROJECT_CREATE_CONFLICT', '项目创建发生并发冲突，请刷新后重试'), 409);
  }
  return c.json(response, 201);
});

p3App.get('/projects', async (c) => {
  const limit = Number(c.req.query('limit') ?? '50');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return c.json(apiError('INVALID_PAGE_LIMIT', 'limit 必须在 1 到 100 之间'), 400);
  const cursorParam = c.req.query('cursor');
  const cursor = parseCursor(cursorParam);
  if (cursorParam && !cursor) return c.json(apiError('INVALID_CURSOR', '分页游标无效'), 400);
  const user = c.get('currentUser');
  const hasAll = user.role === 'admin' || user.scopes.some((scope) => scope.type === 'all');
  const projectIds = user.scopes.filter((scope) => scope.type === 'project' && scope.id).map((scope) => scope.id as string);
  const { database } = createCloudflarePersistence(c.env);
  const page = await new SqlProjectQueryRepository(database).listProjects({
    allowedProjectIds: hasAll ? null : projectIds,
    cursor,
    limit,
  });
  return c.json({ ok: true as const, data: { items: page.items, nextCursor: page.nextCursor ? makeCursor(page.nextCursor.createdAt, page.nextCursor.id) : null } });
});

p3App.get('/projects/:id', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  const detail = await new SqlProjectQueryRepository(database).getProjectDetail(c.req.param('id'));
  if (!detail) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!canAccessProject(c, detail.id)) return c.json(apiError('SCOPE_FORBIDDEN', '当前成员无权访问该项目'), 403);
  return c.json({ ok: true as const, data: detail });
});

p3App.put('/projects/:id/allocations', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: Partial<ReplaceProjectAllocationsRequest>;
  try { body = await c.req.json<Partial<ReplaceProjectAllocationsRequest>>(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expectedVersion = parseExpectedVersion(body.expectedVersion);
  const allocations = validateAllocationInput(body.allocations);
  if (expectedVersion === null || !allocations) return c.json(apiError('INVALID_ALLOCATIONS', 'expectedVersion 或分配明细无效'), 422);
  const operation = `projects.allocations:${c.req.param('id')}`;
  const requestBody = { expectedVersion, allocations };
  const hash = await requestHash(requestBody);
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const project = await findProject(c.env.DB, c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!canAccessProject(c, project.id)) return c.json(apiError('SCOPE_FORBIDDEN', '当前成员无权修改该项目'), 403);
  if (project.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const protectedScope = await protectedProjectScope(c.env.DB, project.id);
  const requestedQuantities = new Map(allocations.map((item) => [item.demandMaterialId, item.quantityScaled]));
  for (const [demandMaterialId, protectedQuantityScaled] of protectedScope) {
    const requestedQuantityScaled = requestedQuantities.get(demandMaterialId) ?? 0;
    if (requestedQuantityScaled < protectedQuantityScaled) {
      return c.json(apiError(
        'PROJECT_SCOPE_PROTECTED',
        '已有出库、实施或有效结算的项目范围不能被储备修改缩小',
        { demandMaterialId, protectedQuantityScaled, requestedQuantityScaled },
      ), 422);
    }
  }

  const actor = c.get('currentUser');
  const now = new Date().toISOString();
  const nextVersion = expectedVersion + 1;
  const response = {
    ok: true as const,
    data: projectSummary({ ...project, status: 'draft', version: nextVersion, updated_at: now }, {
      knownAmountFen: 0,
      missingPriceCount: allocations.length,
      completenessBasisPoints: 0,
    }),
  };
  const statements: D1PreparedStatement[] = [
    projectVersionGuard(c.env.DB, project.id, expectedVersion, now, 'draft'),
    c.env.DB.prepare('DELETE FROM demand_allocations WHERE project_id=?').bind(project.id),
  ];
  for (const allocation of allocations) {
    statements.push(allocationInsertStatement(c.env.DB, project.id, crypto.randomUUID(), allocation.demandMaterialId, allocation.quantityScaled, now));
  }
  statements.push(
    auditStatement(c.env.DB, actor.id, 'project.allocations.replace', 'project', project.id, { version: expectedVersion }, { version: nextVersion, allocations }, now),
    idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, now),
  );
  try {
    await c.env.DB.batch(statements);
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    const current = await findProject(c.env.DB, project.id);
    if (current && current.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    const failure = await allocationFailure(c.env.DB, allocations);
    if (failure) return c.json(apiError(failure.code, failure.message, 'details' in failure ? failure.details : undefined), failure.status);
    return c.json(apiError('ALLOCATION_UPDATE_CONFLICT', '分配更新发生冲突，请刷新后重试'), 409);
  }
  return c.json(response);
});

p3App.put('/projects/:id/costs', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: Partial<ReplaceProjectCostsRequest>;
  try { body = await c.req.json<Partial<ReplaceProjectCostsRequest>>(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expectedVersion = parseExpectedVersion(body.expectedVersion);
  if (expectedVersion === null || !Array.isArray(body.materialPrices) || !Array.isArray(body.fixedCosts)) {
    return c.json(apiError('INVALID_COSTS', 'expectedVersion、物资单价或固定费用格式无效'), 422);
  }
  const operation = `projects.costs:${c.req.param('id')}`;
  const requestBody = { expectedVersion, materialPrices: body.materialPrices, fixedCosts: body.fixedCosts };
  const hash = await requestHash(requestBody);
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const project = await findProject(c.env.DB, c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!canAccessProject(c, project.id)) return c.json(apiError('SCOPE_FORBIDDEN', '当前成员无权修改该项目'), 403);
  if (project.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);

  const allocations = await loadAllocationRows(c.env.DB, project.id);
  if (allocations.length === 0) return c.json(apiError('PROJECT_EMPTY', '项目没有需求物资分配，不能估算'), 422);
  const allocationMap = new Map(allocations.map((item) => [item.id, item]));
  const priceMap = new Map<string, MaterialPriceInput>();
  for (const raw of body.materialPrices) {
    const item = raw as MaterialPriceInput;
    const allocationId = cleanText(item?.demandAllocationId);
    if (!allocationId || !allocationMap.has(allocationId) || priceMap.has(allocationId)) return c.json(apiError('INVALID_MATERIAL_PRICE', '物资单价引用了无效或重复的项目分配'), 422);
    if (item.unitPriceScaled !== null && safeNonNegativeInteger(item.unitPriceScaled) === null) return c.json(apiError('INVALID_MATERIAL_PRICE', '物资单价必须为空或非负安全整数'), 422);
    const priceDate = validDate(item.priceDate);
    if (priceDate === undefined || (item.taxInclusive !== null && typeof item.taxInclusive !== 'boolean')) return c.json(apiError('INVALID_MATERIAL_PRICE', '物资单价日期或含税标记无效'), 422);
    priceMap.set(allocationId, {
      demandAllocationId: allocationId,
      unitPriceScaled: item.unitPriceScaled,
      source: item.source === null || item.source === undefined ? null : cleanText(item.source),
      priceDate,
      taxInclusive: item.taxInclusive,
    });
  }

  const fixedCosts: FixedCostInput[] = [];
  for (const raw of body.fixedCosts) {
    const item = raw as FixedCostInput;
    const kind = item?.kind;
    const label = cleanText(item?.label);
    const amountFen = safeNonNegativeInteger(item?.amountFen);
    const priceDate = validDate(item?.priceDate);
    if ((kind !== 'construction' && kind !== 'other') || !label || label.length > 120 || amountFen === null || priceDate === undefined || (item.taxInclusive !== null && typeof item.taxInclusive !== 'boolean')) {
      return c.json(apiError('INVALID_FIXED_COST', '施工费/其他费明细格式无效'), 422);
    }
    fixedCosts.push({
      kind,
      label,
      amountFen,
      source: item.source === null || item.source === undefined ? null : cleanText(item.source),
      priceDate,
      taxInclusive: item.taxInclusive,
    });
  }

  const now = new Date().toISOString();
  const actor = c.get('currentUser');
  const nextVersion = expectedVersion + 1;
  const materialLines: Array<{
    id: string;
    allocation: AllocationRow;
    price: MaterialPriceInput;
    amountFen: number | null;
  }> = [];
  let knownAmountFen = fixedCosts.reduce((sum, item) => sum + item.amountFen, 0);
  if (!Number.isSafeInteger(knownAmountFen)) return c.json(apiError('AMOUNT_OVERFLOW', '项目估算金额超过安全整数范围'), 422);
  let pricedCount = 0;
  for (const allocation of allocations) {
    const price = priceMap.get(allocation.id) ?? {
      demandAllocationId: allocation.id,
      unitPriceScaled: null,
      source: null,
      priceDate: null,
      taxInclusive: null,
    };
    let amountFen: number | null = null;
    if (price.unitPriceScaled !== null) {
      amountFen = calculateAmountFen(allocation.quantity_scaled, price.unitPriceScaled);
      if (amountFen === null) return c.json(apiError('AMOUNT_OVERFLOW', '物资估算金额超过安全整数范围'), 422);
      knownAmountFen += amountFen;
      if (!Number.isSafeInteger(knownAmountFen)) return c.json(apiError('AMOUNT_OVERFLOW', '项目估算金额超过安全整数范围'), 422);
      pricedCount += 1;
    }
    materialLines.push({ id: crypto.randomUUID(), allocation, price, amountFen });
  }
  const missingPriceCount = allocations.length - pricedCount;
  const completenessBasisPoints = Math.floor((pricedCount * 10000) / allocations.length);
  const summary: ProjectCostSummary = { knownAmountFen, missingPriceCount, completenessBasisPoints };
  const response = {
    ok: true as const,
    data: { version: nextVersion, ...summary },
  };
  const statements: D1PreparedStatement[] = [
    projectVersionGuard(c.env.DB, project.id, expectedVersion, now, 'draft'),
    c.env.DB.prepare('DELETE FROM project_cost_lines WHERE project_id=?').bind(project.id),
  ];
  for (const line of materialLines) {
    const label = line.allocation.material_name
      ? `${line.allocation.material_name} ${line.allocation.material_model ?? line.allocation.raw_model}`
      : line.allocation.raw_model;
    statements.push(c.env.DB.prepare(
      `INSERT INTO project_cost_lines
       (id,project_id,kind,demand_allocation_id,label,unit_price_scaled,amount_fen,price_source,price_date,tax_inclusive,created_at,updated_at)
       VALUES (?,?,'material',?,?,?,?,?,?,?,?,?)`,
    ).bind(
      line.id, project.id, line.allocation.id, label, line.price.unitPriceScaled, line.amountFen,
      line.price.source, line.price.priceDate, line.price.taxInclusive === null ? null : line.price.taxInclusive ? 1 : 0,
      now, now,
    ));
  }
  for (const fixed of fixedCosts) {
    statements.push(c.env.DB.prepare(
      `INSERT INTO project_cost_lines
       (id,project_id,kind,demand_allocation_id,label,unit_price_scaled,amount_fen,price_source,price_date,tax_inclusive,created_at,updated_at)
       VALUES (?,?,?,NULL,?,NULL,?,?,?,?,?,?)`,
    ).bind(
      crypto.randomUUID(), project.id, fixed.kind, fixed.label, fixed.amountFen, fixed.source, fixed.priceDate,
      fixed.taxInclusive === null ? null : fixed.taxInclusive ? 1 : 0, now, now,
    ));
  }
  statements.push(
    auditStatement(c.env.DB, actor.id, 'project.costs.replace', 'project', project.id, { version: expectedVersion }, { version: nextVersion, ...summary }, now),
    idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, now),
  );
  try {
    await c.env.DB.batch(statements);
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    const current = await findProject(c.env.DB, project.id);
    if (current && current.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('COST_UPDATE_CONFLICT', '估算更新发生冲突，请刷新后重试'), 409);
  }
  return c.json(response);
});

p3App.get('/reserve-categories', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlProjectQueryRepository(database).listReserveCategories() } });
});

p3App.post('/reserve-categories', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: { key?: unknown; label?: unknown };
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const categoryKey = cleanText(body.key);
  const label = cleanText(body.label);
  if (!categoryKey || categoryKey.length > 80 || !label || label.length > 120) return c.json(apiError('INVALID_RESERVE_CATEGORY', '储备大类 key 或名称无效'), 422);
  const requestBody = { key: categoryKey, label };
  const hash = await requestHash(requestBody);
  const operation = 'reserve-categories.create';
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const actor = c.get('currentUser');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const data: ReserveCategorySummary = { id, key: categoryKey, label, enabled: true, version: 1 };
  const response = { ok: true as const, data };
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO reserve_categories (id,category_key,label,enabled,version,created_by,created_at,updated_at)
         VALUES (?,?,?,1,1,?,?,?)`,
      ).bind(id, categoryKey, label, actor.id, now, now),
      auditStatement(c.env.DB, actor.id, 'reserve_category.create', 'reserve_category', id, null, data, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 201, now),
    ]);
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    return c.json(apiError('RESERVE_CATEGORY_EXISTS', '储备大类 key 已存在'), 409);
  }
  return c.json(response, 201);
});

p3App.get('/category-mappings', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlProjectQueryRepository(database).listCategoryMappings() } });
});

p3App.put('/category-mappings/:demandCategory', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: { expectedVersion?: unknown; reserveCategoryId?: unknown };
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const demandCategory = cleanText(c.req.param('demandCategory'));
  const reserveCategoryId = cleanText(body.reserveCategoryId);
  const expectedVersion = body.expectedVersion === null ? null : parseExpectedVersion(body.expectedVersion);
  if (!demandCategory || demandCategory.length > 120 || !reserveCategoryId || (body.expectedVersion !== null && expectedVersion === null)) {
    return c.json(apiError('INVALID_CATEGORY_MAPPING', '需求类别、储备大类或 expectedVersion 无效'), 422);
  }
  const requestBody = { expectedVersion, reserveCategoryId };
  const hash = await requestHash(requestBody);
  const operation = `category-mappings:${demandCategory.toLowerCase()}`;
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const category = await c.env.DB.prepare('SELECT id FROM reserve_categories WHERE id=? AND enabled=1 LIMIT 1').bind(reserveCategoryId).first<{ id: string }>();
  if (!category) return c.json(apiError('RESERVE_CATEGORY_NOT_FOUND', '储备大类不存在或已停用'), 404);
  const current = await c.env.DB.prepare(
    `SELECT id,demand_category_key,reserve_category_id,version FROM category_mappings WHERE demand_category_key=? COLLATE NOCASE LIMIT 1`,
  ).bind(demandCategory).first<MappingRow>();
  if (!current && expectedVersion !== null) return c.json(apiError('VERSION_CONFLICT', '类别映射不存在，expectedVersion 应为空'), 409);
  if (current && expectedVersion !== current.version) return c.json(apiError('VERSION_CONFLICT', '类别映射已被修改，请刷新后重试'), 409);

  const actor = c.get('currentUser');
  const now = new Date().toISOString();
  const id = current?.id ?? crypto.randomUUID();
  const nextVersion = current ? current.version + 1 : 1;
  const data: CategoryMappingSummary = { id, demandCategory, reserveCategoryId, version: nextVersion };
  const response = { ok: true as const, data };
  const statements: D1PreparedStatement[] = [];
  if (current) {
    statements.push(c.env.DB.prepare(
      `UPDATE category_mappings
       SET reserve_category_id=?,version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END
       WHERE id=?`,
    ).bind(reserveCategoryId, expectedVersion, now, current.id));
  } else {
    statements.push(c.env.DB.prepare(
      `INSERT INTO category_mappings (id,demand_category_key,reserve_category_id,version,created_by,created_at,updated_at)
       VALUES (?,?,?,1,?,?,?)`,
    ).bind(id, demandCategory, reserveCategoryId, actor.id, now, now));
  }
  statements.push(
    auditStatement(c.env.DB, actor.id, 'category_mapping.upsert', 'category_mapping', id, current ? mappingSummary(current) : null, data, now),
    idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, now),
  );
  try {
    await c.env.DB.batch(statements);
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    return c.json(apiError('VERSION_CONFLICT', '类别映射已被并发修改，请刷新后重试'), 409);
  }
  return c.json(response);
});

p3App.put('/projects/:id/category-allocations', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: Partial<ReplaceCategoryAllocationsRequest>;
  try { body = await c.req.json<Partial<ReplaceCategoryAllocationsRequest>>(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expectedVersion = parseExpectedVersion(body.expectedVersion);
  if (expectedVersion === null || !Array.isArray(body.allocations)) return c.json(apiError('INVALID_CATEGORY_ALLOCATIONS', 'expectedVersion 或分类分摊格式无效'), 422);
  const operation = `projects.category-allocations:${c.req.param('id')}`;
  const requestBody = { expectedVersion, allocations: body.allocations };
  const hash = await requestHash(requestBody);
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const project = await findProject(c.env.DB, c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!canAccessProject(c, project.id)) return c.json(apiError('SCOPE_FORBIDDEN', '当前成员无权修改该项目'), 403);
  if (project.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);

  const costs = await loadCostRows(c.env.DB, project.id);
  const knownCosts = new Map(costs.filter((line) => line.amount_fen !== null).map((line) => [line.id, line.amount_fen as number]));
  const allCosts = new Map(costs.map((line) => [line.id, line]));
  const categoriesResult = await c.env.DB.prepare(
    `SELECT id,category_key,label,enabled,version FROM reserve_categories WHERE enabled=1`,
  ).all<CategoryRow>();
  const categories = new Map((categoriesResult.results ?? []).map((row) => [row.id, row]));
  const seenPairs = new Set<string>();
  const sums = new Map<string, number>();
  const normalized: ReplaceCategoryAllocationsRequest['allocations'] = [];
  for (const raw of body.allocations) {
    if (!raw || typeof raw !== 'object') return c.json(apiError('INVALID_CATEGORY_ALLOCATIONS', '分类分摊明细格式无效'), 422);
    const item = raw as { costLineId?: unknown; reserveCategoryId?: unknown; amountFen?: unknown };
    const costLineId = cleanText(item.costLineId);
    const reserveCategoryId = cleanText(item.reserveCategoryId);
    const amountFen = safeNonNegativeInteger(item.amountFen);
    const pair = `${costLineId}\u0000${reserveCategoryId}`;
    if (!costLineId || !reserveCategoryId || amountFen === null || seenPairs.has(pair)) return c.json(apiError('INVALID_CATEGORY_ALLOCATIONS', '分类分摊存在无效或重复明细'), 422);
    const cost = allCosts.get(costLineId);
    if (!cost) return c.json(apiError('COST_LINE_NOT_FOUND', '费用明细不属于该项目'), 422);
    if (cost.amount_fen === null) return c.json(apiError('COST_LINE_UNKNOWN_AMOUNT', '未知金额费用不能参与分类金额分摊'), 422);
    if (!categories.has(reserveCategoryId)) return c.json(apiError('RESERVE_CATEGORY_NOT_FOUND', '储备大类不存在或已停用'), 422);
    seenPairs.add(pair);
    sums.set(costLineId, (sums.get(costLineId) ?? 0) + amountFen);
    normalized.push({ costLineId, reserveCategoryId, amountFen });
  }
  for (const [costLineId, amountFen] of knownCosts) {
    if ((sums.get(costLineId) ?? 0) !== amountFen) {
      return c.json(apiError('CATEGORY_AMOUNT_MISMATCH', '每条已知费用的分类分摊合计必须等于该费用金额', {
        costLineId,
        expectedAmountFen: amountFen,
        allocatedAmountFen: sums.get(costLineId) ?? 0,
      }), 422);
    }
  }

  const categoryTotals = new Map<string, number>();
  for (const item of normalized) categoryTotals.set(item.reserveCategoryId, (categoryTotals.get(item.reserveCategoryId) ?? 0) + item.amountFen);
  const categorySummaryItems: ProjectCategorySummary[] = [...categoryTotals].map(([categoryId, amountFen]) => {
    const row = categories.get(categoryId)!;
    return { reserveCategoryId: categoryId, key: row.category_key, label: row.label, amountFen };
  }).sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  const knownAmountFen = [...knownCosts.values()].reduce((sum, amount) => sum + amount, 0);
  const classifiedAmountFen = normalized.reduce((sum, item) => sum + item.amountFen, 0);
  const actor = c.get('currentUser');
  const now = new Date().toISOString();
  const nextVersion = expectedVersion + 1;
  const response = {
    ok: true as const,
    data: {
      version: nextVersion,
      knownAmountFen,
      classifiedAmountFen,
      unclassifiedAmountFen: Math.max(0, knownAmountFen - classifiedAmountFen),
      categories: categorySummaryItems,
    },
  };
  const statements: D1PreparedStatement[] = [
    projectVersionGuard(c.env.DB, project.id, expectedVersion, now, 'draft'),
    c.env.DB.prepare('DELETE FROM category_cost_allocations WHERE project_id=?').bind(project.id),
  ];
  for (const item of normalized) {
    statements.push(c.env.DB.prepare(
      `INSERT INTO category_cost_allocations (id,project_id,cost_line_id,reserve_category_id,amount_fen,created_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(crypto.randomUUID(), project.id, item.costLineId, item.reserveCategoryId, item.amountFen, now));
  }
  statements.push(
    auditStatement(c.env.DB, actor.id, 'project.category_allocations.replace', 'project', project.id, { version: expectedVersion }, response.data, now),
    idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, now),
  );
  try {
    await c.env.DB.batch(statements);
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    const current = await findProject(c.env.DB, project.id);
    if (current && current.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('CATEGORY_ALLOCATION_CONFLICT', '分类分摊更新发生冲突，请刷新后重试'), 409);
  }
  return c.json(response);
});

p3App.post('/projects/:id/confirm', requireRoles('admin', 'project_manager'), async (c) => {
  const key = requireIdempotencyKey(c);
  if (key instanceof Response) return key;
  let body: Partial<ConfirmProjectRequest>;
  try { body = await c.req.json<Partial<ConfirmProjectRequest>>(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const expectedVersion = parseExpectedVersion(body.expectedVersion);
  const reason = body.reason === null || body.reason === undefined ? null : cleanText(body.reason);
  if (expectedVersion === null || (reason !== null && reason.length > 500)) return c.json(apiError('INVALID_CONFIRMATION', 'expectedVersion 或确认原因无效'), 422);
  const operation = `projects.confirm:${c.req.param('id')}`;
  const requestBody = { expectedVersion, reason };
  const hash = await requestHash(requestBody);
  const replay = await replayIdempotentResponse(c, key, operation, hash);
  if (replay) return replay;
  const project = await findProject(c.env.DB, c.req.param('id'));
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!canAccessProject(c, project.id)) return c.json(apiError('SCOPE_FORBIDDEN', '当前成员无权确认该项目'), 403);
  if (project.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被修改，请刷新后重试'), 409);
  const detail = await fetchProjectDetail(c.env.DB, project.id);
  if (!detail || detail.allocations.length === 0) return c.json(apiError('PROJECT_EMPTY', '项目没有需求物资分配，不能确认'), 422);

  const actor = c.get('currentUser');
  const now = new Date().toISOString();
  const reserveVersion = project.reserve_version + 1;
  const nextVersion = expectedVersion + 1;
  const versionId = crypto.randomUUID();
  const response = {
    ok: true as const,
    data: {
      id: project.id,
      status: 'confirmed' as const,
      version: nextVersion,
      reserveVersion,
      knownAmountFen: detail.knownAmountFen,
      missingPriceCount: detail.missingPriceCount,
      completenessBasisPoints: detail.completenessBasisPoints,
    },
  };
  try {
    await c.env.DB.batch([
      projectVersionGuard(c.env.DB, project.id, expectedVersion, now, 'confirmed', true),
      c.env.DB.prepare(
        `INSERT INTO project_versions
         (id,project_id,reserve_version,snapshot_json,known_amount_fen,missing_price_count,completeness_basis_points,reason,confirmed_by,confirmed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        versionId, project.id, reserveVersion, JSON.stringify(detail), detail.knownAmountFen,
        detail.missingPriceCount, detail.completenessBasisPoints, reason, actor.id, now,
      ),
      auditStatement(c.env.DB, actor.id, 'project.confirm', 'project', project.id, { version: expectedVersion, reserveVersion: project.reserve_version }, response.data, now),
      idempotencyStatement(c.env.DB, key, actor.id, operation, hash, response, 200, now),
    ]);
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    const current = await findProject(c.env.DB, project.id);
    if (current && current.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '项目已被并发修改，请刷新后重试'), 409);
    return c.json(apiError('PROJECT_CONFIRM_CONFLICT', '储备确认发生冲突，请刷新后重试'), 409);
  }
  return c.json(response);
});

p3App.get('/projects/:id/history', async (c) => {
  const projectId = c.req.param('id');
  const { database } = createCloudflarePersistence(c.env);
  const items = await new SqlProjectQueryRepository(database).getProjectHistory(projectId);
  if (items === null) return c.json(apiError('PROJECT_NOT_FOUND', '储备项目不存在'), 404);
  if (!canAccessProject(c, projectId)) return c.json(apiError('SCOPE_FORBIDDEN', '当前成员无权访问该项目'), 403);
  return c.json({ ok: true as const, data: { items } });
});
