import type { DatabasePort, DatabaseStatement, DatabaseValue } from '../../ports/database.ts';
import type {
  CommitCustomFieldValuesInput,
  CommitMasterConfigInput,
  CommitPhysicalTowerUpdateInput,
  CommitTowerPhysicalRebindInput,
  CustomFieldDefinitionWriteValues,
  TeamWriteValues,
  TowerTypeWriteValues,
} from '../../ports/master-data-write-repository.ts';
import { customFieldEntityTables, jsonValue, masterConfigTables } from './shared.ts';

function configBusinessStatement(input: CommitMasterConfigInput): DatabaseStatement {
  const table = masterConfigTables[input.kind];
  if (input.action === 'delete') return { sql: `DELETE FROM ${table} WHERE id=?`, params: [input.id] };
  if (input.kind === 'team') {
    const values = input.values as TeamWriteValues | undefined;
    if (!values) throw new Error('MASTER_CONFIG_VALUES_REQUIRED');
    if (input.action === 'create') return {
      sql: 'INSERT INTO teams (id,code,name,enabled,version,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
      params: [input.id, values.code, values.name, values.enabled ? 1 : 0, input.mutation.now, input.mutation.now],
    };
    return {
      sql: 'UPDATE teams SET code=?,name=?,enabled=?,version=version+1,updated_at=? WHERE id=?',
      params: [values.code, values.name, values.enabled ? 1 : 0, input.mutation.now, input.id],
    };
  }
  if (input.kind === 'tower-type') {
    const values = input.values as TowerTypeWriteValues | undefined;
    if (!values) throw new Error('MASTER_CONFIG_VALUES_REQUIRED');
    if (input.action === 'create') return {
      sql: 'INSERT INTO tower_types (id,code,label,enabled,sort_order,version,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)',
      params: [input.id, values.code, values.label, values.enabled ? 1 : 0, values.sortOrder, input.mutation.now, input.mutation.now],
    };
    return {
      sql: 'UPDATE tower_types SET code=?,label=?,enabled=?,sort_order=?,version=version+1,updated_at=? WHERE id=?',
      params: [values.code, values.label, values.enabled ? 1 : 0, values.sortOrder, input.mutation.now, input.id],
    };
  }
  const values = input.values as CustomFieldDefinitionWriteValues | undefined;
  if (!values) throw new Error('MASTER_CONFIG_VALUES_REQUIRED');
  if (input.action === 'create') return {
    sql: `INSERT INTO custom_field_definitions
          (id,entity_type,field_key,label,data_type,required,filterable,options_json,validation_json,sort_order,enabled,version,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    params: [input.id, values.entityType, values.fieldKey, values.label, values.dataType, values.required ? 1 : 0, values.filterable ? 1 : 0, values.optionsJson, values.validationJson, values.sortOrder, values.enabled ? 1 : 0, input.mutation.now, input.mutation.now],
  };
  return {
    sql: `UPDATE custom_field_definitions
          SET entity_type=?,field_key=?,label=?,data_type=?,required=?,filterable=?,options_json=?,validation_json=?,sort_order=?,enabled=?,version=version+1,updated_at=?
          WHERE id=?`,
    params: [values.entityType, values.fieldKey, values.label, values.dataType, values.required ? 1 : 0, values.filterable ? 1 : 0, values.optionsJson, values.validationJson, values.sortOrder, values.enabled ? 1 : 0, input.mutation.now, input.id],
  };
}

export async function commitMasterConfig(database: DatabasePort, input: CommitMasterConfigInput): Promise<void> {
  const table = masterConfigTables[input.kind];
  const versionCondition = input.expectedVersion === null
    ? { sql: '1', params: [] as DatabaseValue[] }
    : { sql: `EXISTS(SELECT 1 FROM ${table} WHERE id=? AND version=?)`, params: [input.id, input.expectedVersion] as DatabaseValue[] };
  await database.batch([{
    sql: `INSERT INTO idempotency_records
          (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,CASE WHEN ${versionCondition.sql} THEN ? ELSE NULL END,?,?,?)`,
    params: [input.mutation.key, input.mutation.actorId, input.mutation.operation, ...versionCondition.params, input.mutation.hash, input.mutation.responseJson, input.mutation.statusCode, input.mutation.now],
  }, configBusinessStatement(input), {
    sql: `INSERT INTO audit_events
          (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    params: [input.mutation.auditId, input.mutation.actorId, input.audit.action, input.audit.objectType, input.id, jsonValue(input.audit.before), jsonValue(input.audit.after), input.mutation.now],
  }]);
}

export async function commitPhysicalTowerUpdate(database: DatabasePort, input: CommitPhysicalTowerUpdateInput): Promise<void> {
  await database.batch([{
    sql: `INSERT INTO idempotency_records
          (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,CASE WHEN EXISTS(
            SELECT 1 FROM physical_towers p
            WHERE p.id=? AND p.version=?
              AND (? IS NULL OR EXISTS(SELECT 1 FROM tower_types tt WHERE tt.id=?))
              AND (? IS NULL OR EXISTS(SELECT 1 FROM teams tm WHERE tm.id=?))
          ) THEN ? ELSE NULL END,?,?,?)`,
    params: [input.mutation.key, input.mutation.actorId, input.mutation.operation, input.id, input.expectedVersion, input.values.towerTypeId, input.values.towerTypeId, input.values.maintenanceTeamId, input.values.maintenanceTeamId, input.mutation.hash, input.mutation.responseJson, input.mutation.statusCode, input.mutation.now],
  }, {
    sql: `UPDATE physical_towers
          SET asset_code=?,tower_type_id=?,maintenance_team_id=?,enabled=?,version=version+1,updated_at=?
          WHERE id=?`,
    params: [input.values.assetCode, input.values.towerTypeId, input.values.maintenanceTeamId, input.values.enabled ? 1 : 0, input.mutation.now, input.id],
  }, {
    sql: `INSERT INTO audit_events
          (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    params: [input.mutation.auditId, input.mutation.actorId, input.audit.action, input.audit.objectType, input.id, jsonValue(input.audit.before), jsonValue(input.audit.after), input.mutation.now],
  }]);
}

export async function commitCustomFieldValues(database: DatabasePort, input: CommitCustomFieldValuesInput): Promise<void> {
  const entityTable = customFieldEntityTables[input.entityType];
  const fieldIdsJson = JSON.stringify(input.values.map((item) => item.fieldDefinitionId));
  const versionCondition = input.expectedVersion === null
    ? { sql: 'NOT EXISTS(SELECT 1 FROM custom_field_value_sets WHERE entity_type=? AND entity_id=?)', params: [input.entityType, input.entityId] as DatabaseValue[] }
    : { sql: 'EXISTS(SELECT 1 FROM custom_field_value_sets WHERE entity_type=? AND entity_id=? AND version=?)', params: [input.entityType, input.entityId, input.expectedVersion] as DatabaseValue[] };
  const statements: DatabaseStatement[] = [{
    sql: `INSERT INTO idempotency_records
          (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,CASE WHEN EXISTS(SELECT 1 FROM ${entityTable} WHERE id=?)
            AND ${versionCondition.sql}
            AND NOT EXISTS(
              SELECT 1 FROM json_each(?) supplied
              LEFT JOIN custom_field_definitions d ON d.id=supplied.value
                AND d.entity_type=? AND d.enabled=1
              WHERE d.id IS NULL
            )
          THEN ? ELSE NULL END,?,?,?)`,
    params: [input.mutation.key, input.mutation.actorId, input.mutation.operation, input.entityId, ...versionCondition.params, fieldIdsJson, input.entityType, input.mutation.hash, input.mutation.responseJson, input.mutation.statusCode, input.mutation.now],
  }, {
    sql: `INSERT INTO custom_field_value_sets (entity_type,entity_id,version,created_at,updated_at)
          VALUES (?,?,1,?,?)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=custom_field_value_sets.version+1,updated_at=excluded.updated_at`,
    params: [input.entityType, input.entityId, input.mutation.now, input.mutation.now],
  }, {
    sql: 'DELETE FROM custom_field_values WHERE entity_type=? AND entity_id=?',
    params: [input.entityType, input.entityId],
  }, {
    sql: 'DELETE FROM custom_field_index WHERE entity_type=? AND entity_id=?',
    params: [input.entityType, input.entityId],
  }, {
    sql: 'DELETE FROM custom_field_multi_select_index WHERE entity_type=? AND entity_id=?',
    params: [input.entityType, input.entityId],
  }];
  for (const value of input.values) {
    statements.push({
      sql: `INSERT INTO custom_field_values
            (entity_type,entity_id,field_definition_id,value_json,created_at,updated_at)
            VALUES (?,?,?,?,?,?)`,
      params: [input.entityType, input.entityId, value.fieldDefinitionId, value.valueJson, input.mutation.now, input.mutation.now],
    });
    if (value.filterable) {
      statements.push({
        sql: `INSERT INTO custom_field_index
              (entity_type,entity_id,field_definition_id,text_value,integer_value,date_value,boolean_value,created_at,updated_at)
              SELECT ?,?,?,?,?,?,?,?,?
              WHERE EXISTS(
                SELECT 1 FROM custom_field_definitions
                WHERE id=? AND entity_type=? AND enabled=1 AND filterable=1
              )`,
        params: [input.entityType, input.entityId, value.fieldDefinitionId, value.textValue, value.integerValue, value.dateValue, value.booleanValue, input.mutation.now, input.mutation.now, value.fieldDefinitionId, input.entityType],
      });
      for (const optionValue of value.multiSelectValues) {
        statements.push({
          sql: `INSERT INTO custom_field_multi_select_index
                (entity_type,entity_id,field_definition_id,option_value,created_at,updated_at)
                SELECT ?,?,?,?,?,?
                WHERE EXISTS(
                  SELECT 1 FROM custom_field_definitions
                  WHERE id=? AND entity_type=? AND enabled=1 AND filterable=1 AND data_type='multi_select'
                )`,
          params: [input.entityType, input.entityId, value.fieldDefinitionId, optionValue, input.mutation.now, input.mutation.now, value.fieldDefinitionId, input.entityType],
        });
      }
    }
  }
  statements.push({
    sql: `INSERT INTO audit_events
          (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    params: [input.mutation.auditId, input.mutation.actorId, input.audit.action, input.audit.objectType, input.entityId, jsonValue(input.audit.before), jsonValue(input.audit.after), input.mutation.now],
  });
  await database.batch(statements);
}

export async function commitTowerPhysicalRebind(database: DatabasePort, input: CommitTowerPhysicalRebindInput): Promise<void> {
  await database.batch([{
    sql: `INSERT INTO idempotency_records
          (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,CASE WHEN EXISTS(
            SELECT 1 FROM line_tower_positions WHERE id=? AND version=?
          ) AND EXISTS(
            SELECT 1 FROM physical_towers WHERE id=? AND enabled=1
          ) THEN ? ELSE NULL END,?,?,?)`,
    params: [input.mutation.key, input.mutation.actorId, input.mutation.operation, input.id, input.expectedVersion, input.physicalTowerId, input.mutation.hash, input.mutation.responseJson, input.mutation.statusCode, input.mutation.now],
  }, {
    sql: 'UPDATE line_tower_positions SET physical_tower_id=?,version=version+1,updated_at=? WHERE id=?',
    params: [input.physicalTowerId, input.mutation.now, input.id],
  }, {
    sql: `INSERT INTO audit_events
          (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    params: [input.mutation.auditId, input.mutation.actorId, input.audit.action, input.audit.objectType, input.id, jsonValue(input.audit.before), jsonValue(input.audit.after), input.mutation.now],
  }]);
}
