import { Hono, type Context } from 'hono';
import type {
  CustomFieldDataType,
  CustomFieldDefinitionSummary,
  TeamSummary,
  TowerTypeSummary,
} from '@tpm/shared';
import { requireRoles, type AppEnv } from './auth.ts';
import { beginIdempotentMutation, replayIdempotentMutation, type IdempotentMutation } from './http/idempotent-mutation.ts';
import { apiError, boolValue, cleanText, compactJson, intValue, plainObject } from './http/request-values.ts';
import { customFieldEntityType, masterDataRepository, masterDataWriteRepository } from './master-data-context.ts';
import type {
  CommitMasterConfigInput,
  CustomFieldValueWrite,
  MasterConfigKind,
} from './ports/master-data-write-repository';

export const masterDataConfigApp = new Hono<AppEnv>();

const customFieldDataTypes = new Set<CustomFieldDataType>(['text', 'integer', 'quantity', 'year', 'boolean', 'date', 'single_select', 'multi_select']);
type MasterRecord = Record<string, string | number | null>;
type MasterConfigRoute = 'teams' | 'tower-types' | 'custom-fields';

const masterConfigKinds: Record<MasterConfigRoute, MasterConfigKind> = {
  teams: 'team',
  'tower-types': 'tower-type',
  'custom-fields': 'custom-field',
};

const masterConfigTables: Record<MasterConfigRoute, string> = {
  teams: 'teams',
  'tower-types': 'tower_types',
  'custom-fields': 'custom_field_definitions',
};

masterDataConfigApp.get('/master/teams', async (c) => {
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listTeams() } });
});

masterDataConfigApp.get('/master/tower-types', async (c) => {
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listTowerTypes() } });
});

masterDataConfigApp.get('/master/custom-fields', async (c) => {
  const rawEntityType = cleanText(c.req.query('entityType'), 80) || null;
  const entityType = rawEntityType ? customFieldEntityType(rawEntityType) : null;
  if (rawEntityType && !entityType) return c.json(apiError('INVALID_CUSTOM_FIELD_ENTITY', '自定义字段对象类型无效'), 422);
  return c.json({ ok: true as const, data: { items: await masterDataRepository(c).listCustomFieldDefinitions(entityType) } });
});

function validatedCustomFieldOptions(dataType: CustomFieldDataType, value: unknown): { value: string[] | null; json: string | null } | null {
  if (dataType !== 'single_select' && dataType !== 'multi_select') {
    return value === undefined || value === null ? { value: null, json: null } : null;
  }
  if (!Array.isArray(value) || value.length > 200) return null;
  const cleaned = value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
  if (cleaned.length !== value.length || new Set(cleaned).size !== cleaned.length || cleaned.some((item) => item.length > 120)) return null;
  const json = compactJson(cleaned, 16_000);
  return json ? { value: cleaned, json } : null;
}

function validatedCustomFieldRules(value: unknown): { value: Record<string, unknown>; json: string } | null {
  if (value === undefined || value === null) return { value: {}, json: '{}' };
  const object = plainObject(value);
  if (!object) return null;
  const allowed = new Set(['min', 'max', 'maxLength', 'minItems', 'maxItems']);
  if (Object.keys(object).some((key) => !allowed.has(key))) return null;
  for (const [key, raw] of Object.entries(object)) {
    if (key === 'min' || key === 'max') {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    } else if (!Number.isInteger(raw) || Number(raw) < 0 || Number(raw) > 100_000) return null;
  }
  if (typeof object.min === 'number' && typeof object.max === 'number' && object.min > object.max) return null;
  if (typeof object.minItems === 'number' && typeof object.maxItems === 'number' && object.minItems > object.maxItems) return null;
  const json = compactJson(object, 4_000);
  return json ? { value: object, json } : null;
}

async function prepareMasterConfig(
  c: Context<AppEnv>,
  route: MasterConfigRoute,
  body: Record<string, unknown>,
  id: string,
  before: MasterRecord | null,
) {
  const enabled = boolValue(body.enabled);
  if (enabled === null) return c.json(apiError('INVALID_MASTER_CONFIG', '启用状态必须为布尔值'), 422);
  const version = before ? Number(before.version) + 1 : 1;
  if (route === 'teams') {
    const name = cleanText(body.name, 120), code = cleanText(body.code, 80) || null;
    if (!name) return c.json(apiError('INVALID_TEAM', '班组名称不能为空'), 422);
    const data: TeamSummary = { id, code, name, enabled, version };
    return { values: { code, name, enabled }, data, audit: { action: `master.teams.${before ? 'update' : 'create'}`, objectType: 'teams', before, after: data } };
  }
  if (route === 'tower-types') {
    const label = cleanText(body.label, 120), code = cleanText(body.code, 80) || null;
    const sortOrder = intValue(body.sortOrder ?? 0, 0, 100_000);
    if (!label || sortOrder === null) return c.json(apiError('INVALID_TOWER_TYPE', '杆塔类型名称或排序无效'), 422);
    const data: TowerTypeSummary = { id, code, label, sortOrder, enabled, version };
    return { values: { code, label, sortOrder, enabled }, data, audit: { action: `master.tower-types.${before ? 'update' : 'create'}`, objectType: 'tower_types', before, after: data } };
  }
  const entityType = customFieldEntityType(body.entityType);
  const fieldKey = cleanText(body.fieldKey, 64).toLowerCase();
  const label = cleanText(body.label, 120);
  const dataType = typeof body.dataType === 'string' && customFieldDataTypes.has(body.dataType as CustomFieldDataType)
    ? body.dataType as CustomFieldDataType
    : null;
  const required = boolValue(body.required, false), filterable = boolValue(body.filterable, false);
  const sortOrder = intValue(body.sortOrder ?? 0, 0, 100_000);
  if (!entityType || !/^[a-z][a-z0-9_]{0,63}$/.test(fieldKey) || !label || !dataType || required === null || filterable === null || sortOrder === null) {
    return c.json(apiError('INVALID_CUSTOM_FIELD', '自定义字段对象、键名、名称、类型或排序无效'), 422);
  }
  const options = validatedCustomFieldOptions(dataType, body.options);
  const validation = validatedCustomFieldRules(body.validation);
  if (!options || !validation) return c.json(apiError('INVALID_CUSTOM_FIELD_RULES', '自定义字段选项或校验规则无效'), 422);
  if (before && (
    String(before.entity_type) !== entityType || String(before.field_key) !== fieldKey || String(before.data_type) !== dataType
  )) return c.json(apiError('CUSTOM_FIELD_IDENTITY_IMMUTABLE', '已创建字段不能改变对象类型、字段键或数据类型；请新建字段并停用旧字段'), 422);
  const data: CustomFieldDefinitionSummary = {
    id, entityType, fieldKey, label, dataType, required, filterable,
    options: options.value, validation: validation.value, sortOrder, enabled, version,
  };
  return {
    values: {
      entityType, fieldKey, label, dataType, required, filterable,
      optionsJson: options.json, validationJson: validation.json, sortOrder, enabled,
    },
    data,
    audit: { action: `master.custom-fields.${before ? 'update' : 'create'}`, objectType: 'custom_field_definitions', before, after: data },
  };
}

async function commitMasterConfig(
  c: Context<AppEnv>,
  mutation: IdempotentMutation,
  input: Omit<CommitMasterConfigInput, 'mutation'>,
  data: unknown,
  status: 200 | 201,
) {
  const response = { ok: true as const, data };
  const now = new Date().toISOString();
  try {
    await masterDataWriteRepository(c).commitConfig({
      ...input,
      mutation: {
        key: mutation.key,
        actorId: c.get('currentUser').id,
        operation: mutation.operation,
        hash: mutation.hash,
        responseJson: JSON.stringify(response),
        statusCode: status,
        now,
        auditId: crypto.randomUUID(),
      },
    });
  } catch (cause) {
    const raced = await replayIdempotentMutation(c, mutation); if (raced) return raced;
    const error = String(cause);
    if (error.includes('idempotency_records.request_hash')) return c.json(apiError('VERSION_CONFLICT', '配置已变化，请刷新后重试'), 409);
    if (error.includes('UNIQUE constraint')) return c.json(apiError('MASTER_CONFIG_CONFLICT', '配置名称、编码或字段键重复，请检查'), 409);
    if (error.includes('FOREIGN KEY constraint')) return c.json(apiError('MASTER_CONFIG_IN_USE', '配置已被业务数据使用，不能删除；请停用'), 422);
    throw cause;
  }
  return c.json(response, status);
}

for (const route of Object.keys(masterConfigKinds) as MasterConfigRoute[]) {
  for (const method of ['post', 'patch', 'delete'] as const) {
    masterDataConfigApp[method](`/master/${route}${method === 'post' ? '' : '/:id'}`, requireRoles('admin'), async (c) => {
      let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
      const mutation = await beginIdempotentMutation(c, body); if (mutation instanceof Response) return mutation;
      const repository = masterDataWriteRepository(c);
      const id = method === 'post' ? crypto.randomUUID() : c.req.param('id');
      const kind = masterConfigKinds[route];
      const before = method === 'post' ? null : await repository.findConfigRecord(kind, id);
      if (method !== 'post' && !before) return c.json(apiError('MASTER_CONFIG_NOT_FOUND', '配置对象不存在'), 404);
      const expectedVersion = method === 'post' ? null : intValue(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER);
      if (method !== 'post' && expectedVersion === null) return c.json(apiError('INVALID_VERSION', 'expectedVersion 必须为正整数'), 422);
      if (before && Number(before.version) !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '配置已变化，请刷新后重试'), 409);
      if (method === 'delete') {
        return commitMasterConfig(c, mutation, {
          kind, action: 'delete', id, expectedVersion,
          audit: { action: `master.${route}.delete`, objectType: masterConfigTables[route], before, after: null },
        }, { id, deleted: true }, 200);
      }
      const prepared = await prepareMasterConfig(c, route, body, id, before); if (prepared instanceof Response) return prepared;
      return commitMasterConfig(c, mutation, {
        kind,
        action: method === 'post' ? 'create' : 'update',
        id,
        values: prepared.values,
        expectedVersion,
        audit: prepared.audit,
      }, prepared.data, method === 'post' ? 201 : 200);
    });
  }
}

function customFieldValueIsEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

function normalizeCustomFieldValue(definition: CustomFieldDefinitionSummary, raw: unknown): { normalized: unknown; write: CustomFieldValueWrite } | string {
  let normalized: unknown = raw;
  let textValue: string | null = null;
  let integerValue: number | null = null;
  let dateValue: string | null = null;
  let booleanValue: number | null = null;
  let multiSelectValues: string[] = [];
  const rules = definition.validation;
  if (definition.dataType === 'text') {
    if (typeof raw !== 'string') return `${definition.label}必须为文本`;
    normalized = raw.trim();
    if (!normalized) return `${definition.label}不能为空文本`;
    const maxLength = typeof rules.maxLength === 'number' ? rules.maxLength : 5000;
    if ((normalized as string).length > maxLength) return `${definition.label}超过最大长度 ${maxLength}`;
    textValue = normalized as string;
  } else if (definition.dataType === 'integer' || definition.dataType === 'quantity' || definition.dataType === 'year') {
    if (!Number.isSafeInteger(raw)) return `${definition.label}必须为整数`;
    const numeric = Number(raw);
    if (definition.dataType === 'year' && (numeric < 1900 || numeric > 2200)) return `${definition.label}必须在 1900–2200 之间`;
    if (typeof rules.min === 'number' && numeric < rules.min) return `${definition.label}不能小于 ${rules.min}`;
    if (typeof rules.max === 'number' && numeric > rules.max) return `${definition.label}不能大于 ${rules.max}`;
    normalized = numeric; integerValue = numeric;
  } else if (definition.dataType === 'boolean') {
    if (typeof raw !== 'boolean') return `${definition.label}必须为布尔值`;
    normalized = raw; booleanValue = raw ? 1 : 0;
  } else if (definition.dataType === 'date') {
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) return `${definition.label}必须为 YYYY-MM-DD 日期`;
    normalized = raw; dateValue = raw;
  } else if (definition.dataType === 'single_select') {
    if (typeof raw !== 'string' || !raw.trim()) return `${definition.label}必须选择一个选项`;
    const option = raw.trim(), options = Array.isArray(definition.options) ? definition.options : [];
    if (!options.includes(option)) return `${definition.label}包含未配置选项`;
    normalized = option; textValue = option;
  } else {
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || !item.trim())) return `${definition.label}必须为选项数组`;
    const values = raw.map((item) => String(item).trim());
    if (new Set(values).size !== values.length) return `${definition.label}不能包含重复选项`;
    const options = Array.isArray(definition.options) ? definition.options : [];
    if (values.some((item) => !options.includes(item))) return `${definition.label}包含未配置选项`;
    if (typeof rules.minItems === 'number' && values.length < rules.minItems) return `${definition.label}至少选择 ${rules.minItems} 项`;
    if (typeof rules.maxItems === 'number' && values.length > rules.maxItems) return `${definition.label}最多选择 ${rules.maxItems} 项`;
    normalized = values; multiSelectValues = values;
  }
  const valueJson = compactJson(normalized, 16_000);
  if (!valueJson) return `${definition.label}序列化后过大`;
  return {
    normalized,
    write: {
      fieldDefinitionId: definition.id,
      valueJson,
      textValue,
      integerValue,
      dateValue,
      booleanValue,
      multiSelectValues,
      filterable: definition.filterable,
    },
  };
}

masterDataConfigApp.get('/master/custom-values/:entityType/:entityId', async (c) => {
  const entityType = customFieldEntityType(c.req.param('entityType'));
  const entityId = cleanText(c.req.param('entityId'), 120);
  if (!entityType || !entityId) return c.json(apiError('INVALID_CUSTOM_FIELD_ENTITY', '自定义字段对象类型或对象 ID 无效'), 422);
  if (!await masterDataWriteRepository(c).findCustomFieldEntity(entityType, entityId)) return c.json(apiError('CUSTOM_FIELD_ENTITY_NOT_FOUND', '自定义字段所属对象不存在'), 404);
  return c.json({ ok: true as const, data: await masterDataRepository(c).getCustomFieldValues(entityType, entityId) });
});

masterDataConfigApp.put('/master/custom-values/:entityType/:entityId', requireRoles('admin'), async (c) => {
  let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json(apiError('INVALID_JSON', '请求体不是有效 JSON'), 400); }
  const mutation = await beginIdempotentMutation(c, body); if (mutation instanceof Response) return mutation;
  const entityType = customFieldEntityType(c.req.param('entityType'));
  const entityId = cleanText(c.req.param('entityId'), 120);
  if (!entityType || !entityId) return c.json(apiError('INVALID_CUSTOM_FIELD_ENTITY', '自定义字段对象类型或对象 ID 无效'), 422);
  const repository = masterDataWriteRepository(c);
  if (!await repository.findCustomFieldEntity(entityType, entityId)) return c.json(apiError('CUSTOM_FIELD_ENTITY_NOT_FOUND', '自定义字段所属对象不存在'), 404);
  const current = await masterDataRepository(c).getCustomFieldValues(entityType, entityId);
  const expectedVersion = body.expectedVersion === null ? null : intValue(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER);
  if (body.expectedVersion !== null && expectedVersion === null) return c.json(apiError('INVALID_VERSION', 'expectedVersion 必须为 null 或正整数'), 422);
  if (current.version !== expectedVersion) return c.json(apiError('VERSION_CONFLICT', '自定义字段值已变化，请刷新后重试', { currentVersion: current.version }), 409);
  const rawValues = plainObject(body.values);
  if (!rawValues || Object.keys(rawValues).length > 100) return c.json(apiError('INVALID_CUSTOM_FIELD_VALUES', '自定义字段值必须为对象且最多 100 项'), 422);
  const definitions = (await masterDataRepository(c).listCustomFieldDefinitions(entityType)).filter((item) => item.enabled);
  const byKey = new Map(definitions.map((item) => [item.fieldKey, item]));
  const unknownKeys = Object.keys(rawValues).filter((key) => !byKey.has(key));
  if (unknownKeys.length) return c.json(apiError('UNKNOWN_CUSTOM_FIELD', `存在未配置字段：${unknownKeys.slice(0, 5).join('、')}`), 422);
  const normalizedValues: Record<string, unknown> = {};
  const writes: CustomFieldValueWrite[] = [];
  for (const definition of definitions) {
    const raw = rawValues[definition.fieldKey];
    if (customFieldValueIsEmpty(raw)) {
      if (definition.required) return c.json(apiError('CUSTOM_FIELD_REQUIRED', `${definition.label}不能为空`), 422);
      continue;
    }
    const parsed = normalizeCustomFieldValue(definition, raw);
    if (typeof parsed === 'string') return c.json(apiError('INVALID_CUSTOM_FIELD_VALUE', parsed), 422);
    normalizedValues[definition.fieldKey] = parsed.normalized;
    writes.push(parsed.write);
  }
  const nextVersion = (current.version ?? 0) + 1;
  const data = { entityType, entityId, version: nextVersion, values: normalizedValues };
  const response = { ok: true as const, data }, now = new Date().toISOString();
  try {
    await repository.commitCustomFieldValues({
      entityType,
      entityId,
      expectedVersion,
      values: writes,
      mutation: {
        key: mutation.key, actorId: c.get('currentUser').id, operation: mutation.operation, hash: mutation.hash,
        responseJson: JSON.stringify(response), statusCode: 200, now, auditId: crypto.randomUUID(),
      },
      audit: { action: 'master.custom-values.replace', objectType: entityType, before: current, after: data },
    });
  } catch (cause) {
    const raced = await replayIdempotentMutation(c, mutation); if (raced) return raced;
    if (String(cause).includes('idempotency_records.request_hash')) return c.json(apiError('VERSION_CONFLICT', '自定义字段值或字段定义已变化，请刷新后重试'), 409);
    throw cause;
  }
  return c.json(response);
});
