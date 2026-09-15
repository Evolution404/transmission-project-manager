import { Hono, type Context } from 'hono';
import type { PhysicalTowerSummary } from '@tpm/shared';
import { requireRoles, type AppEnv } from './auth.ts';
import { beginIdempotentMutation, replayIdempotentMutation } from './http/idempotent-mutation.ts';
import { apiError, boolValue, cleanText, intValue } from './http/request-values.ts';
import { masterDataRepository, masterDataWriteRepository } from './master-data-context.ts';

export const physicalTowersApp = new Hono<AppEnv>();

physicalTowersApp.get('/master/physical-towers', async (c) => {
  const limit = Number(c.req.query('limit') ?? '100');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.json(apiError('INVALID_PAGE_LIMIT', 'limit 必须在 1–100 之间'), 400);
  const query = cleanText(c.req.query('query'), 120) || null;
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listPhysicalTowers({ query, limit }) } });
});

async function physicalTowerSummaryById(c: Context<AppEnv>, id: string): Promise<PhysicalTowerSummary | null> {
  const rows = await masterDataRepository(c).listPhysicalTowers({ query: id, limit: 100 });
  return rows.find((item) => item.id === id) ?? null;
}

physicalTowersApp.patch('/master/physical-towers/:id', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const mutation = await beginIdempotentMutation(c, body); if (mutation instanceof Response) return mutation;
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
    const raced = await replayIdempotentMutation(c, mutation); if (raced) return raced;
    const error = String(cause);
    if (error.includes('idempotency_records.request_hash')) return c.json(apiError('VERSION_CONFLICT', '物理杆塔已变化，请刷新后重试'), 409);
    if (error.includes('FOREIGN KEY constraint')) return c.json(apiError('PHYSICAL_TOWER_RELATION_INVALID', '物理杆塔关联的配置对象无效'), 422);
    throw cause;
  }
  return c.json(response);
});

physicalTowersApp.post('/master/towers/:id/rebind-physical', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const mutation = await beginIdempotentMutation(c, body); if (mutation instanceof Response) return mutation;
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
    const raced = await replayIdempotentMutation(c, mutation); if (raced) return raced;
    if (String(cause).includes('idempotency_records.request_hash')) return c.json(apiError('VERSION_CONFLICT', '线路杆塔或物理杆塔已变化，请刷新后重试'), 409);
    throw cause;
  }
  return c.json(response);
});
