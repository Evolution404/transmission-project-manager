import type { DatabasePort, DatabaseStatement } from '../ports/database.ts';
import type { AppendDemandMaterialsRecord, DemandMaterialWriteRepository, DemandMaterialWriteState } from '../ports/demand-material-write-repository.ts';

function auditStatement(input: { id: string; actorId: string; demandId: string; expectedVersion: number; added: number; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?, 'demand.materials.add','demand',?,?,?,?)`,
    params: [input.id, input.actorId, input.demandId, JSON.stringify({ version: input.expectedVersion }), JSON.stringify({ version: input.expectedVersion + 1, added: input.added }), input.now],
  };
}

function idempotencyStatement(input: { key: string; actorId: string; operation: string; hash: string; responseJson: string; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,?,?,200,?)`,
    params: [input.key, input.actorId, input.operation, input.hash, input.responseJson, input.now],
  };
}

export class SqlDemandMaterialWriteRepository implements DemandMaterialWriteRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async findState(demandId: string): Promise<DemandMaterialWriteState | null> {
    const row = await this.database.first<{ id: string; version: number }>({ sql: `SELECT id,version FROM demands WHERE id=? LIMIT 1`, params: [demandId] });
    return row ? { id: row.id, version: row.version } : null;
  }

  async append(input: AppendDemandMaterialsRecord): Promise<void> {
    await this.database.batch([
      {
        sql: `UPDATE demands SET version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END WHERE id=?`,
        params: [input.expectedVersion, input.now, input.demandId],
      },
      ...input.rows.map((row) => ({
        sql: `INSERT INTO demand_materials (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at,source_import_row_id,created_by,version)
              VALUES (?,?,?,?,?,?,?,NULL,?,1)`,
        params: [row.id, input.demandId, row.rawModel, row.materialId, row.quantityScaled, row.unit, input.now, input.actorId],
      })),
      auditStatement({ id: input.auditId, actorId: input.actorId, demandId: input.demandId, expectedVersion: input.expectedVersion, added: input.rows.length, now: input.now }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, now: input.now }),
    ]);
  }
}
