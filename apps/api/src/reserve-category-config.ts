import { Hono } from 'hono';
import type { CategoryMappingSummary, ReserveCategorySummary } from '@tpm/shared';
import { requireRoles, type AppEnv } from './auth.ts';
import { replayIdempotentResponse, requestHash, requireIdempotencyKey } from './http/idempotent-mutation.ts';
import { apiError, coercedPositiveIntegerValue as parseExpectedVersion } from './http/request-values.ts';
import { SqlProjectQueryRepository } from './repositories/sql-project-query-repository.ts';
import { SqlReserveCategoryWriteRepository } from './repositories/sql-reserve-category-write-repository.ts';
import { resolvePersistence as createCloudflarePersistence } from './runtime/persistence.ts';

function cleanText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export const reserveCategoryConfigApp = new Hono<AppEnv>();

reserveCategoryConfigApp.get('/reserve-categories', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlProjectQueryRepository(database).listReserveCategories() } });
});

reserveCategoryConfigApp.post('/reserve-categories', requireRoles('admin', 'project_manager'), async (c) => {
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
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlReserveCategoryWriteRepository(database);
  try {
    await repository.createCategory({
      category: data,
      actorId: actor.id,
      now,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
    });
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    return c.json(apiError('RESERVE_CATEGORY_EXISTS', '储备大类 key 已存在'), 409);
  }
  return c.json(response, 201);
});

reserveCategoryConfigApp.get('/category-mappings', async (c) => {
  const { database } = createCloudflarePersistence(c.env);
  return c.json({ ok: true as const, data: { items: await new SqlProjectQueryRepository(database).listCategoryMappings() } });
});

reserveCategoryConfigApp.put('/category-mappings/:demandCategory', requireRoles('admin', 'project_manager'), async (c) => {
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
  const { database } = createCloudflarePersistence(c.env);
  const repository = new SqlReserveCategoryWriteRepository(database);
  const category = await repository.findCategory(reserveCategoryId);
  if (!category?.enabled) return c.json(apiError('RESERVE_CATEGORY_NOT_FOUND', '储备大类不存在或已停用'), 404);
  const current = await repository.findMapping(demandCategory);
  if (!current && expectedVersion !== null) return c.json(apiError('VERSION_CONFLICT', '类别映射不存在，expectedVersion 应为空'), 409);
  if (current && expectedVersion !== current.version) return c.json(apiError('VERSION_CONFLICT', '类别映射已被修改，请刷新后重试'), 409);

  const actor = c.get('currentUser');
  const now = new Date().toISOString();
  const id = current?.id ?? crypto.randomUUID();
  const nextVersion = current ? current.version + 1 : 1;
  const data: CategoryMappingSummary = { id, demandCategory, reserveCategoryId, version: nextVersion };
  const response = { ok: true as const, data };
  try {
    await repository.upsertMapping({
      mapping: data,
      expectedVersion,
      actorId: actor.id,
      now,
      auditId: crypto.randomUUID(),
      idempotencyKey: key,
      operation,
      requestHash: hash,
      responseJson: JSON.stringify(response),
      before: current,
    });
  } catch {
    const replayAfterRace = await replayIdempotentResponse(c, key, operation, hash);
    if (replayAfterRace) return replayAfterRace;
    return c.json(apiError('VERSION_CONFLICT', '类别映射已被并发修改，请刷新后重试'), 409);
  }
  return c.json(response);
});
