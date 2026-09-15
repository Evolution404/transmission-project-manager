import type { DatabasePort, DatabaseStatement, DatabaseValue } from '../../ports/database.ts';
import type {
  CommitSingleMasterDataInput,
  LineTowerPositionWriteValues,
  TransmissionLineWriteValues,
  VoltageLevelWriteValues,
} from '../../ports/master-data-write-repository.ts';
import { jsonValue, masterDataTables } from './shared.ts';

export function singleMasterBusinessStatement(input: CommitSingleMasterDataInput): DatabaseStatement {
  const table = masterDataTables[input.kind];
  if (input.action === 'delete') return { sql: `DELETE FROM ${table} WHERE id=?`, params: [input.id] };

  if (input.kind === 'voltage-level') {
    const values = input.values as VoltageLevelWriteValues | undefined;
    if (!values) throw new Error('MASTER_DATA_VALUES_REQUIRED');
    const params: DatabaseValue[] = [values.code, values.displayName, values.systemType, values.nominalKv, values.sortOrder, values.enabled ? 1 : 0];
    if (input.action === 'create') {
      return {
        sql: `INSERT INTO voltage_levels
              (id,code,display_name,system_type,nominal_kv,sort_order,enabled,version,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,1,?,?)`,
        params: [input.id, ...params, input.mutation.now, input.mutation.now],
      };
    }
    return {
      sql: `UPDATE voltage_levels SET code=?,display_name=?,system_type=?,nominal_kv=?,sort_order=?,enabled=?,version=version+1,updated_at=? WHERE id=?`,
      params: [...params, input.mutation.now, input.id],
    };
  }

  if (input.kind === 'line') {
    const values = input.values as TransmissionLineWriteValues | undefined;
    if (!values) throw new Error('MASTER_DATA_VALUES_REQUIRED');
    const params: DatabaseValue[] = [values.voltageLevelId, values.lineName, values.lineCode, values.enabled ? 1 : 0];
    if (input.action === 'create') {
      return {
        sql: `INSERT INTO transmission_lines
              (id,voltage_level_id,line_name,line_code,name_valid_from,enabled,version,tower_order_version,created_at,updated_at)
              VALUES (?,?,?,?,?, ?,1,1,?,?)`,
        params: [input.id, values.voltageLevelId, values.lineName, values.lineCode, input.mutation.now, values.enabled ? 1 : 0, input.mutation.now, input.mutation.now],
      };
    }
    return {
      sql: `UPDATE transmission_lines SET voltage_level_id=?,line_name=?,line_code=?,enabled=?,version=version+1,updated_at=? WHERE id=?`,
      params: [...params, input.mutation.now, input.id],
    };
  }

  const values = input.values as LineTowerPositionWriteValues | undefined;
  if (!values) throw new Error('MASTER_DATA_VALUES_REQUIRED');
  const params: DatabaseValue[] = [values.lineId, values.physicalTowerId, values.towerNo, values.sortRank, values.positionLabel, values.enabled ? 1 : 0];
  if (input.action === 'create') {
    return {
      sql: `INSERT INTO line_tower_positions
            (id,line_id,physical_tower_id,tower_no,number_valid_from,sort_rank,position_label,enabled,version,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,1,?,?)`,
      params: [input.id, values.lineId, values.physicalTowerId, values.towerNo, input.mutation.now, values.sortRank, values.positionLabel, values.enabled ? 1 : 0, input.mutation.now, input.mutation.now],
    };
  }
  return {
    sql: `UPDATE line_tower_positions SET line_id=?,physical_tower_id=?,tower_no=?,sort_rank=?,position_label=?,enabled=?,version=version+1,updated_at=? WHERE id=?`,
    params: [...params, input.mutation.now, input.id],
  };
}

export async function commitSingleMasterData(database: DatabasePort, input: CommitSingleMasterDataInput): Promise<void> {
  const table = masterDataTables[input.kind];
  const versionCondition = input.expectedVersion === null
    ? { sql: '1', params: [] as DatabaseValue[] }
    : { sql: `EXISTS(SELECT 1 FROM ${table} WHERE id=? AND version=?)`, params: [input.id, input.expectedVersion] as DatabaseValue[] };
  const orderCondition = input.changesTowerOrder
    ? {
        sql: 'EXISTS(SELECT 1 FROM transmission_lines WHERE id=? AND tower_order_version=?)',
        params: [input.parentLineId!, input.expectedTowerOrderVersion!] as DatabaseValue[],
      }
    : { sql: '1', params: [] as DatabaseValue[] };
  const statements: DatabaseStatement[] = [{
    sql: `INSERT INTO idempotency_records
          (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,CASE WHEN ${versionCondition.sql} AND ${orderCondition.sql} THEN ? ELSE NULL END,?,?,?)`,
    params: [input.mutation.key, input.mutation.actorId, input.mutation.operation, ...versionCondition.params, ...orderCondition.params, input.mutation.hash, input.mutation.responseJson, input.mutation.statusCode, input.mutation.now],
  }];

  if (input.kind === 'line' && input.action !== 'delete') {
    const values = input.values as TransmissionLineWriteValues | undefined;
    if (!values) throw new Error('MASTER_DATA_VALUES_REQUIRED');
    statements.push({
      sql: `INSERT INTO master_data_guards (id,voltage_parent)
            VALUES (1,CASE WHEN EXISTS (
              SELECT 1 FROM voltage_levels WHERE id=?${input.requireEnabledParent ? ' AND enabled=1' : ''}
            ) THEN 1 ELSE 0 END)
            ON CONFLICT(id) DO UPDATE SET voltage_parent=excluded.voltage_parent`,
      params: [values.voltageLevelId],
    });
  }
  if (input.kind === 'tower-position' && input.action !== 'delete') {
    const values = input.values as LineTowerPositionWriteValues | undefined;
    if (!values) throw new Error('MASTER_DATA_VALUES_REQUIRED');
    statements.push({
      sql: `INSERT INTO master_data_guards (id,line_parent)
            VALUES (1,CASE WHEN EXISTS (
              SELECT 1 FROM transmission_lines l
              JOIN voltage_levels v ON v.id=l.voltage_level_id
              WHERE l.id=?${input.requireEnabledParent ? ' AND l.enabled=1 AND v.enabled=1' : ''}
            ) THEN 1 ELSE 0 END)
            ON CONFLICT(id) DO UPDATE SET line_parent=excluded.line_parent`,
      params: [values.lineId],
    });
  }
  if (input.kind === 'voltage-level' && input.action === 'update') {
    const values = input.values as VoltageLevelWriteValues | undefined;
    if (!values) throw new Error('MASTER_DATA_VALUES_REQUIRED');
    statements.push({
      sql: `INSERT INTO master_data_guards (id,voltage_reference)
            VALUES (1,CASE WHEN NOT EXISTS (
              SELECT 1 FROM voltage_levels WHERE id=? AND (nominal_kv IS NOT ? OR system_type IS NOT ?)
            ) OR NOT EXISTS (
              SELECT 1 FROM demands WHERE voltage_level_id=?
            ) THEN 1 ELSE 0 END)
            ON CONFLICT(id) DO UPDATE SET voltage_reference=excluded.voltage_reference`,
      params: [input.id, values.nominalKv, values.systemType, input.id],
    });
  }
  if (input.kind === 'line' && input.action === 'update') {
    const values = input.values as TransmissionLineWriteValues | undefined;
    if (!values) throw new Error('MASTER_DATA_VALUES_REQUIRED');
    statements.push({
      sql: `INSERT INTO master_data_guards (id,line_reference)
            VALUES (1,CASE WHEN NOT EXISTS (
              SELECT 1 FROM transmission_lines WHERE id=? AND voltage_level_id IS NOT ?
            ) OR NOT EXISTS (
              SELECT 1 FROM demands WHERE line_id=?
            ) THEN 1 ELSE 0 END)
            ON CONFLICT(id) DO UPDATE SET line_reference=excluded.line_reference`,
      params: [input.id, values.voltageLevelId, input.id],
    });
  }
  if (input.kind === 'tower-position' && input.action === 'update') {
    const values = input.values as LineTowerPositionWriteValues | undefined;
    if (!values) throw new Error('MASTER_DATA_VALUES_REQUIRED');
    statements.push({
      sql: `INSERT INTO master_data_guards (id,tower_reference)
            VALUES (1,CASE WHEN NOT EXISTS (
              SELECT 1 FROM line_tower_positions
              WHERE id=? AND line_id IS NOT ?
            ) OR NOT EXISTS (
              SELECT 1 FROM demands
              WHERE line_id IN ((SELECT line_id FROM line_tower_positions WHERE id=?), ?)
            ) THEN 1 ELSE 0 END)
            ON CONFLICT(id) DO UPDATE SET tower_reference=excluded.tower_reference`,
      params: [input.id, values.lineId, input.id, values.lineId],
    });
  }
  if (input.kind === 'tower-position' && input.action === 'delete') {
    statements.push({
      sql: `INSERT INTO master_data_guards (id,tower_reference)
            VALUES (1,CASE WHEN NOT EXISTS (
              SELECT 1 FROM demands
              WHERE start_tower_position_id=? OR end_tower_position_id=?
            ) THEN 1 ELSE 0 END)
            ON CONFLICT(id) DO UPDATE SET tower_reference=excluded.tower_reference`,
      params: [input.id, input.id],
    });
  }
  if (input.rebalanceTowerOrder) {
    statements.push({
      sql: `WITH ranked(id,new_rank) AS MATERIALIZED (
              SELECT id,-ROW_NUMBER() OVER (ORDER BY sort_rank,id)*1000
              FROM line_tower_positions WHERE line_id=?
            )
            UPDATE line_tower_positions
            SET sort_rank=(SELECT new_rank FROM ranked WHERE ranked.id=line_tower_positions.id)
            WHERE line_id=?`,
      params: [input.parentLineId!, input.parentLineId!],
    }, {
      sql: 'UPDATE line_tower_positions SET sort_rank=-sort_rank WHERE line_id=?',
      params: [input.parentLineId!],
    });
  }
  if (input.createPhysicalTower) {
    const physical = input.createPhysicalTower;
    statements.push({
      sql: `INSERT INTO physical_towers
            (id,asset_code,tower_type_id,maintenance_team_id,enabled,version,created_at,updated_at)
            VALUES (?,?,?,?,?,1,?,?)`,
      params: [physical.id, physical.assetCode, physical.towerTypeId, physical.maintenanceTeamId, physical.enabled ? 1 : 0, input.mutation.now, input.mutation.now],
    });
  }
  statements.push(singleMasterBusinessStatement(input));
  if (input.changesTowerOrder) {
    statements.push({
      sql: `UPDATE transmission_lines
            SET tower_order_version=tower_order_version+1,updated_at=?
            WHERE id=? AND tower_order_version=?`,
      params: [input.mutation.now, input.parentLineId!, input.expectedTowerOrderVersion!],
    });
  }
  statements.push({
    sql: `INSERT INTO audit_events
          (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    params: [input.mutation.auditId, input.mutation.actorId, input.audit.action, input.audit.objectType, input.id, jsonValue(input.audit.before), jsonValue(input.audit.after), input.mutation.now],
  });
  await database.batch(statements);
}
