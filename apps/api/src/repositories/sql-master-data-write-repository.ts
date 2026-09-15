import type { CustomFieldEntityType } from '@tpm/shared';
import type { DatabasePort, DatabaseStatement, DatabaseValue } from '../ports/database.ts';
import type {
  CommitCustomFieldValuesInput,
  CommitLineRenameInput,
  CommitMasterConfigInput,
  CommitPhysicalTowerUpdateInput,
  CommitSingleMasterDataInput,
  CommitTowerPhysicalRebindInput,
  CommitTowerImportChunkInput,
  CommitTowerMoveInput,
  CommitTowerReorderInput,
  CommitTowerRenameInput,
  MasterDataWriteKind,
  MasterDataWriteRepository,
  LineTowerPositionWriteValues,
  MasterConfigKind,
  TeamWriteValues,
  TowerTypeWriteValues,
  CustomFieldDefinitionWriteValues,
  TransmissionLineWriteValues,
  VoltageLevelWriteValues,
} from '../ports/master-data-write-repository.ts';

const tables: Record<MasterDataWriteKind, string> = {
  'voltage-level': 'voltage_levels',
  line: 'transmission_lines',
  'tower-position': 'line_tower_positions',
};
const configTables: Record<MasterConfigKind, string> = {
  team: 'teams',
  'tower-type': 'tower_types',
  'custom-field': 'custom_field_definitions',
};
const customEntityTables: Record<CustomFieldEntityType, string> = {
  physical_tower: 'physical_towers',
  transmission_line: 'transmission_lines',
  line_tower_position: 'line_tower_positions',
  demand: 'demands',
  project: 'projects',
  project_task: 'project_tasks',
};

function json(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}

export class SqlMasterDataWriteRepository implements MasterDataWriteRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async findRecord(kind: MasterDataWriteKind, id: string): Promise<Record<string, string | number | null> | null> {
    return this.database.first({ sql: `SELECT * FROM ${tables[kind]} WHERE id=? LIMIT 1`, params: [id] });
  }

  async findTowerRecords(ids: readonly string[]): Promise<readonly Record<string, string | number | null>[]> {
    if (!ids.length) return [];
    return this.database.all({
      sql: `SELECT * FROM line_tower_positions WHERE id IN (${ids.map(() => '?').join(',')})`,
      params: [...ids],
    });
  }

  async findPhysicalTower(id: string): Promise<Record<string, string | number | null> | null> {
    return this.database.first({ sql: 'SELECT * FROM physical_towers WHERE id=? LIMIT 1', params: [id] });
  }

  async findCustomFieldEntity(entityType: CustomFieldEntityType, id: string): Promise<Record<string, string | number | null> | null> {
    return this.database.first({ sql: `SELECT * FROM ${customEntityTables[entityType]} WHERE id=? LIMIT 1`, params: [id] });
  }

  async findConfigRecord(kind: MasterConfigKind, id: string): Promise<Record<string, string | number | null> | null> {
    return this.database.first({ sql: `SELECT * FROM ${configTables[kind]} WHERE id=? LIMIT 1`, params: [id] });
  }

  async findVoltageParent(id: string): Promise<{ displayName: string; enabled: boolean } | null> {
    const row = await this.database.first<{ display_name: string; enabled: number }>({
      sql: 'SELECT display_name,enabled FROM voltage_levels WHERE id=? LIMIT 1',
      params: [id],
    });
    return row ? { displayName: row.display_name, enabled: row.enabled === 1 } : null;
  }

  async findTowerParent(lineId: string): Promise<{ lineName: string; enabled: boolean; voltageEnabled: boolean; towerOrderVersion: number } | null> {
    const row = await this.database.first<{ line_name: string; enabled: number; voltage_enabled: number; tower_order_version: number }>({
      sql: `SELECT l.line_name,l.enabled,l.tower_order_version,v.enabled AS voltage_enabled
            FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id
            WHERE l.id=? LIMIT 1`,
      params: [lineId],
    });
    return row ? { lineName: row.line_name, enabled: row.enabled === 1, voltageEnabled: row.voltage_enabled === 1, towerOrderVersion: row.tower_order_version } : null;
  }

  async listTowerOrder(lineId: string): Promise<readonly { id: string; towerNo: string; sortRank: number }[]> {
    const rows = await this.database.all<{ id: string; tower_no: string; sort_rank: number }>({
      sql: 'SELECT id,tower_no,sort_rank FROM line_tower_positions WHERE line_id=? ORDER BY sort_rank,id',
      params: [lineId],
    });
    return rows.map((row) => ({ id: row.id, towerNo: row.tower_no, sortRank: row.sort_rank }));
  }

  async countLineTowers(lineId: string): Promise<number> {
    const row = await this.database.first<{ total: number }>({
      sql: 'SELECT COUNT(*) AS total FROM line_tower_positions WHERE line_id=?',
      params: [lineId],
    });
    return Number(row?.total ?? 0);
  }

  async commitSingle(input: CommitSingleMasterDataInput): Promise<void> {
    const table = tables[input.kind];
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
      params: [
        input.mutation.key,
        input.mutation.actorId,
        input.mutation.operation,
        ...versionCondition.params,
        ...orderCondition.params,
        input.mutation.hash,
        input.mutation.responseJson,
        input.mutation.statusCode,
        input.mutation.now,
      ],
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
      });
      statements.push({
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
    statements.push(this.businessStatement(input));
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
      params: [
        input.mutation.auditId,
        input.mutation.actorId,
        input.audit.action,
        input.audit.objectType,
        input.id,
        json(input.audit.before),
        json(input.audit.after),
        input.mutation.now,
      ],
    });
    await this.database.batch(statements);
  }

  async commitTowerImportChunk(input: CommitTowerImportChunkInput): Promise<void> {
    const updates = input.items.filter((item) => item.action === 'update');
    const updateCondition = updates.length
      ? updates.map(() => 'EXISTS(SELECT 1 FROM line_tower_positions WHERE id=? AND line_id=? AND version=?)').join(' AND ')
      : '1';
    const updateParams = updates.flatMap((item) => [item.id, input.lineId, item.expectedVersion!] as DatabaseValue[]);
    const statements: DatabaseStatement[] = [{
      sql: `INSERT INTO idempotency_records
            (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (?,?,?,CASE WHEN EXISTS(
              SELECT 1 FROM transmission_lines WHERE id=? AND tower_order_version=?
            ) AND ${updateCondition} THEN ? ELSE NULL END,?,?,?)`,
      params: [
        input.mutation.key,
        input.mutation.actorId,
        input.mutation.operation,
        input.lineId,
        input.expectedTowerOrderVersion,
        ...updateParams,
        input.mutation.hash,
        input.mutation.responseJson,
        input.mutation.statusCode,
        input.mutation.now,
      ],
    }, {
      sql: `INSERT INTO master_data_guards (id,line_parent)
            VALUES (1,CASE WHEN EXISTS (
              SELECT 1 FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id
              WHERE l.id=? AND l.enabled=1 AND v.enabled=1
            ) THEN 1 ELSE 0 END)
            ON CONFLICT(id) DO UPDATE SET line_parent=excluded.line_parent`,
      params: [input.lineId],
    }];

    if (input.rebalanceTowerOrder) {
      statements.push({
        sql: `WITH ranked(id,new_rank) AS MATERIALIZED (
                SELECT id,-ROW_NUMBER() OVER (ORDER BY sort_rank,id)*1000
                FROM line_tower_positions WHERE line_id=?
              )
              UPDATE line_tower_positions
              SET sort_rank=(SELECT new_rank FROM ranked WHERE ranked.id=line_tower_positions.id)
              WHERE line_id=?`,
        params: [input.lineId, input.lineId],
      }, {
        sql: 'UPDATE line_tower_positions SET sort_rank=-sort_rank WHERE line_id=?',
        params: [input.lineId],
      });
    }

    for (const item of input.items) {
      if (item.createPhysicalTower) {
        const physical = item.createPhysicalTower;
        statements.push({
          sql: `INSERT INTO physical_towers
                (id,asset_code,tower_type_id,maintenance_team_id,enabled,version,created_at,updated_at)
                VALUES (?,?,?,?,?,1,?,?)`,
          params: [physical.id, physical.assetCode, physical.towerTypeId, physical.maintenanceTeamId, physical.enabled ? 1 : 0, input.mutation.now, input.mutation.now],
        });
      }
      statements.push(this.businessStatement({
        kind: 'tower-position',
        action: item.action,
        id: item.id,
        values: item.values,
        expectedVersion: item.expectedVersion,
        mutation: input.mutation,
        audit: { action: '', objectType: '', before: null, after: null },
      }));
    }
    if (input.changesTowerOrder) {
      statements.push({
        sql: `UPDATE transmission_lines
              SET tower_order_version=tower_order_version+1,updated_at=?
              WHERE id=? AND tower_order_version=?`,
        params: [input.mutation.now, input.lineId, input.expectedTowerOrderVersion],
      });
    }
    statements.push({
      sql: `INSERT INTO audit_events
            (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
      params: [
        input.mutation.auditId,
        input.mutation.actorId,
        input.audit.action,
        input.audit.objectType,
        input.lineId,
        json(input.audit.before),
        json(input.audit.after),
        input.mutation.now,
      ],
    });
    await this.database.batch(statements);
  }

  async commitTowerReorder(input: CommitTowerReorderInput): Promise<void> {
    const idsJson = JSON.stringify(input.towerIds);
    const statements: DatabaseStatement[] = [{
      sql: `INSERT INTO idempotency_records
            (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (?,?,?,CASE WHEN EXISTS(
              SELECT 1 FROM transmission_lines WHERE id=? AND tower_order_version=?
            ) AND (SELECT COUNT(*) FROM line_tower_positions WHERE line_id=?)=?
              AND NOT EXISTS(
                SELECT 1 FROM line_tower_positions t
                WHERE t.line_id=? AND t.id NOT IN (SELECT value FROM json_each(?))
              )
            THEN ? ELSE NULL END,?,?,?)`,
      params: [
        input.mutation.key,
        input.mutation.actorId,
        input.mutation.operation,
        input.lineId,
        input.expectedTowerOrderVersion,
        input.lineId,
        input.towerIds.length,
        input.lineId,
        idsJson,
        input.mutation.hash,
        input.mutation.responseJson,
        input.mutation.statusCode,
        input.mutation.now,
      ],
    }, {
      sql: `WITH desired(id,new_rank) AS MATERIALIZED (
              SELECT value,-(CAST(key AS INTEGER)+1)*1000 FROM json_each(?)
            )
            UPDATE line_tower_positions
            SET sort_rank=(SELECT new_rank FROM desired WHERE desired.id=line_tower_positions.id)
            WHERE line_id=?`,
      params: [idsJson, input.lineId],
    }, {
      sql: 'UPDATE line_tower_positions SET sort_rank=-sort_rank WHERE line_id=?',
      params: [input.lineId],
    }, {
      sql: `UPDATE transmission_lines
            SET tower_order_version=tower_order_version+1,updated_at=?
            WHERE id=? AND tower_order_version=?`,
      params: [input.mutation.now, input.lineId, input.expectedTowerOrderVersion],
    }, {
      sql: `INSERT INTO audit_events
            (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
      params: [
        input.mutation.auditId,
        input.mutation.actorId,
        input.audit.action,
        input.audit.objectType,
        input.lineId,
        json(input.audit.before),
        json(input.audit.after),
        input.mutation.now,
      ],
    }];
    await this.database.batch(statements);
  }

  async commitLineRename(input: CommitLineRenameInput): Promise<void> {
    const statements: DatabaseStatement[] = [{
      sql: `INSERT INTO idempotency_records
            (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (?,?,?,CASE WHEN EXISTS(
              SELECT 1 FROM transmission_lines WHERE id=? AND version=?
            ) THEN ? ELSE NULL END,?,?,?)`,
      params: [
        input.mutation.key,
        input.mutation.actorId,
        input.mutation.operation,
        input.id,
        input.expectedVersion,
        input.mutation.hash,
        input.mutation.responseJson,
        input.mutation.statusCode,
        input.mutation.now,
      ],
    }, {
      sql: `INSERT INTO transmission_line_name_history
            (id,line_id,line_name,valid_from,valid_to,changed_by,change_reason,created_at)
            SELECT ?,id,line_name,name_valid_from,?,?,?,?
            FROM transmission_lines WHERE id=? AND version=?`,
      params: [
        input.historyId,
        input.mutation.now,
        input.mutation.actorId,
        input.reason,
        input.mutation.now,
        input.id,
        input.expectedVersion,
      ],
    }, {
      sql: `UPDATE transmission_lines
            SET line_name=?,name_valid_from=?,version=version+1,updated_at=?
            WHERE id=? AND version=?`,
      params: [input.lineName, input.mutation.now, input.mutation.now, input.id, input.expectedVersion],
    }, {
      sql: `INSERT INTO audit_events
            (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
      params: [
        input.mutation.auditId,
        input.mutation.actorId,
        input.audit.action,
        input.audit.objectType,
        input.id,
        json(input.audit.before),
        json(input.audit.after),
        input.mutation.now,
      ],
    }];
    await this.database.batch(statements);
  }

  async commitTowerRename(input: CommitTowerRenameInput): Promise<void> {
    const statements: DatabaseStatement[] = [{
      sql: `INSERT INTO idempotency_records
            (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (?,?,?,CASE WHEN EXISTS(
              SELECT 1 FROM line_tower_positions WHERE id=? AND version=?
            ) THEN ? ELSE NULL END,?,?,?)`,
      params: [
        input.mutation.key,
        input.mutation.actorId,
        input.mutation.operation,
        input.id,
        input.expectedVersion,
        input.mutation.hash,
        input.mutation.responseJson,
        input.mutation.statusCode,
        input.mutation.now,
      ],
    }, {
      sql: `INSERT INTO line_tower_position_no_history
            (id,line_tower_position_id,line_id,tower_no,valid_from,valid_to,changed_by,change_reason,created_at)
            SELECT ?,id,line_id,tower_no,number_valid_from,?,?,?,?
            FROM line_tower_positions WHERE id=? AND version=?`,
      params: [
        input.historyId,
        input.mutation.now,
        input.mutation.actorId,
        input.reason,
        input.mutation.now,
        input.id,
        input.expectedVersion,
      ],
    }, {
      sql: `UPDATE line_tower_positions
            SET tower_no=?,number_valid_from=?,version=version+1,updated_at=?
            WHERE id=? AND version=?`,
      params: [input.towerNo, input.mutation.now, input.mutation.now, input.id, input.expectedVersion],
    }, {
      sql: `INSERT INTO audit_events
            (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
      params: [
        input.mutation.auditId,
        input.mutation.actorId,
        input.audit.action,
        input.audit.objectType,
        input.id,
        json(input.audit.before),
        json(input.audit.after),
        input.mutation.now,
      ],
    }];
    await this.database.batch(statements);
  }

  async commitTowerMove(input: CommitTowerMoveInput): Promise<void> {
    const statements: DatabaseStatement[] = [{
      sql: `INSERT INTO idempotency_records
            (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (?,?,?,CASE WHEN EXISTS(
              SELECT 1 FROM transmission_lines WHERE id=? AND tower_order_version=?
            ) AND EXISTS(
              SELECT 1 FROM line_tower_positions WHERE id=? AND line_id=?
            ) AND EXISTS(
              SELECT 1 FROM line_tower_positions WHERE id=? AND line_id=?
            ) THEN ? ELSE NULL END,?,?,?)`,
      params: [
        input.mutation.key,
        input.mutation.actorId,
        input.mutation.operation,
        input.lineId,
        input.expectedTowerOrderVersion,
        input.towerId,
        input.lineId,
        input.targetTowerId,
        input.lineId,
        input.mutation.hash,
        input.mutation.responseJson,
        input.mutation.statusCode,
        input.mutation.now,
      ],
    }];

    if (input.rebalance) {
      statements.push({
        sql: `WITH ranked(id,new_rank) AS MATERIALIZED (
                SELECT id,-ROW_NUMBER() OVER (ORDER BY sort_rank,id)*1000
                FROM line_tower_positions WHERE line_id=?
              )
              UPDATE line_tower_positions
              SET sort_rank=(SELECT new_rank FROM ranked WHERE ranked.id=line_tower_positions.id)
              WHERE line_id=?`,
        params: [input.lineId, input.lineId],
      });
      statements.push({
        sql: 'UPDATE line_tower_positions SET sort_rank=-sort_rank WHERE line_id=?',
        params: [input.lineId],
      });
    }

    statements.push({
      sql: 'UPDATE line_tower_positions SET sort_rank=-9007199254740000 WHERE id=? AND line_id=?',
      params: [input.towerId, input.lineId],
    });
    if (input.placement === 'before') {
      statements.push({
        sql: `UPDATE line_tower_positions
              SET sort_rank=(
                SELECT CAST((COALESCE((
                  SELECT MAX(previous.sort_rank) FROM line_tower_positions previous
                  WHERE previous.line_id=? AND previous.id<>? AND previous.sort_rank>0
                    AND previous.sort_rank<target.sort_rank
                ),0)+target.sort_rank)/2 AS INTEGER)
                FROM line_tower_positions target WHERE target.id=? AND target.line_id=?
              ),updated_at=?
              WHERE id=? AND line_id=?`,
        params: [input.lineId, input.towerId, input.targetTowerId, input.lineId, input.mutation.now, input.towerId, input.lineId],
      });
    } else {
      statements.push({
        sql: `UPDATE line_tower_positions
              SET sort_rank=(
                SELECT CASE WHEN (
                  SELECT MIN(next.sort_rank) FROM line_tower_positions next
                  WHERE next.line_id=? AND next.id<>? AND next.sort_rank>target.sort_rank
                ) IS NULL THEN target.sort_rank+1000 ELSE CAST((target.sort_rank+(
                  SELECT MIN(next.sort_rank) FROM line_tower_positions next
                  WHERE next.line_id=? AND next.id<>? AND next.sort_rank>target.sort_rank
                ))/2 AS INTEGER) END
                FROM line_tower_positions target WHERE target.id=? AND target.line_id=?
              ),updated_at=?
              WHERE id=? AND line_id=?`,
        params: [
          input.lineId, input.towerId,
          input.lineId, input.towerId,
          input.targetTowerId, input.lineId,
          input.mutation.now, input.towerId, input.lineId,
        ],
      });
    }
    statements.push({
      sql: `UPDATE transmission_lines
            SET tower_order_version=tower_order_version+1,updated_at=?
            WHERE id=? AND tower_order_version=?`,
      params: [input.mutation.now, input.lineId, input.expectedTowerOrderVersion],
    });
    statements.push({
      sql: `INSERT INTO audit_events
            (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
      params: [
        input.mutation.auditId,
        input.mutation.actorId,
        input.audit.action,
        input.audit.objectType,
        input.towerId,
        json(input.audit.before),
        json(input.audit.after),
        input.mutation.now,
      ],
    });
    await this.database.batch(statements);
  }

  async commitConfig(input: CommitMasterConfigInput): Promise<void> {
    const table = configTables[input.kind];
    const versionCondition = input.expectedVersion === null
      ? { sql: '1', params: [] as DatabaseValue[] }
      : { sql: `EXISTS(SELECT 1 FROM ${table} WHERE id=? AND version=?)`, params: [input.id, input.expectedVersion] as DatabaseValue[] };
    const statements: DatabaseStatement[] = [{
      sql: `INSERT INTO idempotency_records
            (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (?,?,?,CASE WHEN ${versionCondition.sql} THEN ? ELSE NULL END,?,?,?)`,
      params: [
        input.mutation.key,
        input.mutation.actorId,
        input.mutation.operation,
        ...versionCondition.params,
        input.mutation.hash,
        input.mutation.responseJson,
        input.mutation.statusCode,
        input.mutation.now,
      ],
    }];
    statements.push(this.configBusinessStatement(input));
    statements.push({
      sql: `INSERT INTO audit_events
            (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
      params: [
        input.mutation.auditId,
        input.mutation.actorId,
        input.audit.action,
        input.audit.objectType,
        input.id,
        json(input.audit.before),
        json(input.audit.after),
        input.mutation.now,
      ],
    });
    await this.database.batch(statements);
  }

  async commitPhysicalTowerUpdate(input: CommitPhysicalTowerUpdateInput): Promise<void> {
    const statements: DatabaseStatement[] = [{
      sql: `INSERT INTO idempotency_records
            (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (?,?,?,CASE WHEN EXISTS(
              SELECT 1 FROM physical_towers p
              WHERE p.id=? AND p.version=?
                AND (? IS NULL OR EXISTS(SELECT 1 FROM tower_types tt WHERE tt.id=?))
                AND (? IS NULL OR EXISTS(SELECT 1 FROM teams tm WHERE tm.id=?))
            ) THEN ? ELSE NULL END,?,?,?)`,
      params: [
        input.mutation.key,
        input.mutation.actorId,
        input.mutation.operation,
        input.id,
        input.expectedVersion,
        input.values.towerTypeId,
        input.values.towerTypeId,
        input.values.maintenanceTeamId,
        input.values.maintenanceTeamId,
        input.mutation.hash,
        input.mutation.responseJson,
        input.mutation.statusCode,
        input.mutation.now,
      ],
    }, {
      sql: `UPDATE physical_towers
            SET asset_code=?,tower_type_id=?,maintenance_team_id=?,enabled=?,version=version+1,updated_at=?
            WHERE id=?`,
      params: [
        input.values.assetCode,
        input.values.towerTypeId,
        input.values.maintenanceTeamId,
        input.values.enabled ? 1 : 0,
        input.mutation.now,
        input.id,
      ],
    }];
    statements.push({
      sql: `INSERT INTO audit_events
            (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
      params: [input.mutation.auditId, input.mutation.actorId, input.audit.action, input.audit.objectType, input.id, json(input.audit.before), json(input.audit.after), input.mutation.now],
    });
    await this.database.batch(statements);
  }

  async commitCustomFieldValues(input: CommitCustomFieldValuesInput): Promise<void> {
    const entityTable = customEntityTables[input.entityType];
    const fieldIdsJson = JSON.stringify(input.values.map((item) => item.fieldDefinitionId));
    const versionCondition = input.expectedVersion === null
      ? {
          sql: `NOT EXISTS(SELECT 1 FROM custom_field_value_sets WHERE entity_type=? AND entity_id=?)`,
          params: [input.entityType, input.entityId] as DatabaseValue[],
        }
      : {
          sql: `EXISTS(SELECT 1 FROM custom_field_value_sets WHERE entity_type=? AND entity_id=? AND version=?)`,
          params: [input.entityType, input.entityId, input.expectedVersion] as DatabaseValue[],
        };
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
      params: [
        input.mutation.key,
        input.mutation.actorId,
        input.mutation.operation,
        input.entityId,
        ...versionCondition.params,
        fieldIdsJson,
        input.entityType,
        input.mutation.hash,
        input.mutation.responseJson,
        input.mutation.statusCode,
        input.mutation.now,
      ],
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
          params: [
            input.entityType,
            input.entityId,
            value.fieldDefinitionId,
            value.textValue,
            value.integerValue,
            value.dateValue,
            value.booleanValue,
            input.mutation.now,
            input.mutation.now,
            value.fieldDefinitionId,
            input.entityType,
          ],
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
            params: [
              input.entityType,
              input.entityId,
              value.fieldDefinitionId,
              optionValue,
              input.mutation.now,
              input.mutation.now,
              value.fieldDefinitionId,
              input.entityType,
            ],
          });
        }
      }
    }
    statements.push({
      sql: `INSERT INTO audit_events
            (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
      params: [input.mutation.auditId, input.mutation.actorId, input.audit.action, input.audit.objectType, input.entityId, json(input.audit.before), json(input.audit.after), input.mutation.now],
    });
    await this.database.batch(statements);
  }

  async commitTowerPhysicalRebind(input: CommitTowerPhysicalRebindInput): Promise<void> {
    await this.database.batch([{
      sql: `INSERT INTO idempotency_records
            (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (?,?,?,CASE WHEN EXISTS(
              SELECT 1 FROM line_tower_positions WHERE id=? AND version=?
            ) AND EXISTS(
              SELECT 1 FROM physical_towers WHERE id=? AND enabled=1
            ) THEN ? ELSE NULL END,?,?,?)`,
      params: [
        input.mutation.key,
        input.mutation.actorId,
        input.mutation.operation,
        input.id,
        input.expectedVersion,
        input.physicalTowerId,
        input.mutation.hash,
        input.mutation.responseJson,
        input.mutation.statusCode,
        input.mutation.now,
      ],
    }, {
      sql: `UPDATE line_tower_positions SET physical_tower_id=?,version=version+1,updated_at=? WHERE id=?`,
      params: [input.physicalTowerId, input.mutation.now, input.id],
    }, {
      sql: `INSERT INTO audit_events
            (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
      params: [input.mutation.auditId, input.mutation.actorId, input.audit.action, input.audit.objectType, input.id, json(input.audit.before), json(input.audit.after), input.mutation.now],
    }]);
  }

  private configBusinessStatement(input: CommitMasterConfigInput): DatabaseStatement {
    const table = configTables[input.kind];
    if (input.action === 'delete') return { sql: `DELETE FROM ${table} WHERE id=?`, params: [input.id] };
    if (input.kind === 'team') {
      const values = input.values as TeamWriteValues | undefined;
      if (!values) throw new Error('MASTER_CONFIG_VALUES_REQUIRED');
      if (input.action === 'create') return {
        sql: `INSERT INTO teams (id,code,name,enabled,version,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`,
        params: [input.id, values.code, values.name, values.enabled ? 1 : 0, input.mutation.now, input.mutation.now],
      };
      return {
        sql: `UPDATE teams SET code=?,name=?,enabled=?,version=version+1,updated_at=? WHERE id=?`,
        params: [values.code, values.name, values.enabled ? 1 : 0, input.mutation.now, input.id],
      };
    }
    if (input.kind === 'tower-type') {
      const values = input.values as TowerTypeWriteValues | undefined;
      if (!values) throw new Error('MASTER_CONFIG_VALUES_REQUIRED');
      if (input.action === 'create') return {
        sql: `INSERT INTO tower_types (id,code,label,enabled,sort_order,version,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)`,
        params: [input.id, values.code, values.label, values.enabled ? 1 : 0, values.sortOrder, input.mutation.now, input.mutation.now],
      };
      return {
        sql: `UPDATE tower_types SET code=?,label=?,enabled=?,sort_order=?,version=version+1,updated_at=? WHERE id=?`,
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

  private businessStatement(input: CommitSingleMasterDataInput): DatabaseStatement {
    const table = tables[input.kind];
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
}
