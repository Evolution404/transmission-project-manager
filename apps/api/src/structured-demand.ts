import { Hono, type Context } from 'hono';
import type {
  CreateStructuredDemandRequest,
  DemandDetail,
  DemandLocationType,
  DemandMaterialInput,
} from '@tpm/shared';
import { requireRoles, type AppEnv } from './auth.ts';
import { beginIdempotentMutation, replayIdempotentMutation } from './http/idempotent-mutation.ts';
import { apiError, cleanText, hashValue, intValue } from './http/request-values.ts';
import { SqlDemandRepository } from './repositories/sql-demand-repository.ts';
import { resolvePersistence } from './runtime/persistence.ts';

export const structuredDemandApp = new Hono<AppEnv>();

const constraintMessages: Record<string, string> = {
  INVALID_GRID_LOCATION: '需求位置关联已变化或停用，请刷新并先维护基础台账',
};

function demandRepository(c: Context<AppEnv>) {
  const { database } = resolvePersistence(c.env);
  return new SqlDemandRepository(database);
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

function locationType(value: unknown): DemandLocationType | null {
  return value === 'whole_line' || value === 'tower' || value === 'tower_range' ? value : null;
}

structuredDemandApp.post('/demands', requireRoles('admin', 'project_manager'), async (c) => {
  let body: Partial<CreateStructuredDemandRequest> & Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const mutation = await beginIdempotentMutation(c, body); if (mutation instanceof Response) return mutation;
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
    const raced = await replayIdempotentMutation(c, mutation); if (raced) return raced;
    const error = String(cause);
    for (const [code, message] of Object.entries(constraintMessages)) if (error.includes(code)) return c.json(apiError(code, message), 422);
    if (error.includes('UNIQUE constraint')) return c.json(apiError('DEMAND_CONFLICT', '需求或来源已存在，请刷新后重试'), 409);
    throw cause;
  }
  return c.json(response, 201);
});
