import type { DatabasePort, DatabaseStatement, DatabaseValue } from '../ports/database.ts';
import type {
  CommitSingleMasterDataInput,
  CommitTowerBatchInput,
  MasterDataWriteKind,
  MasterDataWriteRepository,
  TransmissionLineWriteValues,
  TransmissionTowerWriteValues,
  VoltageLevelWriteValues,
} from '../ports/master-data-write-repository.ts';

const tables: Record<MasterDataWriteKind, string> = {
  'voltage-level': 'voltage_levels',
  line: 'transmission_lines',
  tower: 'transmission_towers',
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
      sql: `SELECT * FROM transmission_towers WHERE id IN (${ids.map(() => '?').join(',')})`,
      params: [...ids],
    });
  }

  async findVoltageParent(id: string): Promise<{ displayName: string; enabled: boolean } | null> {
    const row = await this.database.first<{ display_name: string; enabled: number }>({
      sql: 'SELECT display_name,enabled FROM voltage_levels WHERE id=? LIMIT 1',
      params: [id],
    });
    return row ? { displayName: row.display_name, enabled: row.enabled === 1 } : null;
  }

  async findTowerParent(lineId: string): Promise<{ lineName: string; enabled: boolean; voltageEnabled: boolean } | null> {
    const row = await this.database.first<{ line_name: string; enabled: number; voltage_enabled: number }>({
      sql: `SELECT l.line_name,l.enabled,v.enabled AS voltage_enabled
            FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id
            WHERE l.id=? LIMIT 1`,
      params: [lineId],
    });
    return row ? { lineName: row.line_name, enabled: row.enabled === 1, voltageEnabled: row.voltage_enabled === 1 } : null;
  }

  async countLineTowers(lineId: string): Promise<number> {
    const row = await this.database.first<{ total: number }>({
      sql: 'SELECT COUNT(*) AS total FROM transmission_towers WHERE line_id=?',
      params: [lineId],
    });
    return Number(row?.total ?? 0);
  }

  async commitSingle(input: CommitSingleMasterDataInput): Promise<void> {
    const table = tables[input.kind];
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

    if (input.kind === 'line' && input.action !== 'delete') {
      const values = input.values as TransmissionLineWriteValues | undefined;
      if (!values) throw new Error('MASTER_DATA_VALUES_REQUIRED');
      statements.push({
        sql: `INSERT INTO master_data_guards (valid)
              VALUES (CASE WHEN EXISTS (
                SELECT 1 FROM voltage_levels WHERE id=?${input.requireEnabledParent ? ' AND enabled=1' : ''}
              ) THEN 1 ELSE 0 END)`,
        params: [values.voltageLevelId],
      });
    }
    if (input.kind === 'tower' && input.action !== 'delete') {
      const values = input.values as TransmissionTowerWriteValues | undefined;
      if (!values) throw new Error('MASTER_DATA_VALUES_REQUIRED');
      statements.push({
        sql: `INSERT INTO master_data_guards (valid)
              VALUES (CASE WHEN EXISTS (
                SELECT 1 FROM transmission_lines l
                JOIN voltage_levels v ON v.id=l.voltage_level_id
                WHERE l.id=?${input.requireEnabledParent ? ' AND l.enabled=1 AND v.enabled=1' : ''}
              ) THEN 1 ELSE 0 END)`,
        params: [values.lineId],
      });
    }

    statements.push(this.businessStatement(input));
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

  async commitTowerBatch(input: CommitTowerBatchInput): Promise<void> {
    const guarded = input.items.filter((item) => item.expectedVersion !== null);
    const condition = guarded.length
      ? guarded.map(() => 'EXISTS(SELECT 1 FROM transmission_towers WHERE id=? AND version=?)').join(' AND ')
      : '1';
    const conditionParams = guarded.flatMap((item) => [item.id, item.expectedVersion!] as DatabaseValue[]);
    const statements: DatabaseStatement[] = [{
      sql: `INSERT INTO idempotency_records
            (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (?,?,?,CASE WHEN ${condition} THEN ? ELSE NULL END,?,?,?)`,
      params: [
        input.mutation.key,
        input.mutation.actorId,
        input.mutation.operation,
        ...conditionParams,
        input.mutation.hash,
        input.mutation.responseJson,
        input.mutation.statusCode,
        input.mutation.now,
      ],
    }, {
      sql: `INSERT INTO master_data_guards (valid)
            VALUES (CASE WHEN EXISTS (
              SELECT 1 FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id
              WHERE l.id=? AND l.enabled=1 AND v.enabled=1
            ) THEN 1 ELSE 0 END)`,
      params: [input.lineId],
    }];

    let temporaryIndex = 0;
    for (const item of input.items) {
      if (!item.vacateUniqueKeys) continue;
      statements.push({
        sql: 'UPDATE transmission_towers SET sort_index=?,tower_no=? WHERE id=?',
        params: [-1000001 - temporaryIndex, `temporary:${item.id}`, item.id],
      });
      temporaryIndex += 1;
    }
    for (const item of input.items) {
      statements.push(this.businessStatement({
        kind: 'tower',
        action: item.expectedVersion === null ? 'create' : 'update',
        id: item.id,
        values: item.values,
        expectedVersion: item.expectedVersion,
        mutation: input.mutation,
        audit: { action: '', objectType: '', before: null, after: null },
      }));
    }
    statements.push({
      sql: `INSERT INTO audit_events
            (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
      params: [
        input.mutation.auditId,
        input.mutation.actorId,
        'master.towers.batch',
        'transmission_line',
        input.lineId,
        json(input.audit.before),
        json(input.audit.after),
        input.mutation.now,
      ],
    });
    await this.database.batch(statements);
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
                (id,voltage_level_id,line_name,line_code,enabled,version,created_at,updated_at)
                VALUES (?,?,?,?,?,1,?,?)`,
          params: [input.id, ...params, input.mutation.now, input.mutation.now],
        };
      }
      return {
        sql: `UPDATE transmission_lines SET voltage_level_id=?,line_name=?,line_code=?,enabled=?,version=version+1,updated_at=? WHERE id=?`,
        params: [...params, input.mutation.now, input.id],
      };
    }

    const values = input.values as TransmissionTowerWriteValues | undefined;
    if (!values) throw new Error('MASTER_DATA_VALUES_REQUIRED');
    const params: DatabaseValue[] = [values.lineId, values.towerNo, values.sortIndex, values.towerType, values.enabled ? 1 : 0];
    if (input.action === 'create') {
      return {
        sql: `INSERT INTO transmission_towers
              (id,line_id,tower_no,sort_index,tower_type,enabled,version,created_at,updated_at)
              VALUES (?,?,?,?,?,?,1,?,?)`,
        params: [input.id, ...params, input.mutation.now, input.mutation.now],
      };
    }
    return {
      sql: `UPDATE transmission_towers SET line_id=?,tower_no=?,sort_index=?,tower_type=?,enabled=?,version=version+1,updated_at=? WHERE id=?`,
      params: [...params, input.mutation.now, input.id],
    };
  }
}
