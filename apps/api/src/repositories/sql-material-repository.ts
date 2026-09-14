import type { MaterialSummary } from '@tpm/shared';
import type { DatabasePort } from '../ports/database.ts';
import type { CreateMaterialRecord, MaterialRepository } from '../ports/material-repository.ts';

type MaterialRow = {
  id: string;
  code: string | null;
  name: string;
  model: string;
  unit: string;
  enabled: number;
  version: number;
};

function summary(row: MaterialRow): MaterialSummary {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    model: row.model,
    unit: row.unit,
    enabled: row.enabled === 1,
    version: row.version,
  };
}

export class SqlMaterialRepository implements MaterialRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async list(input: { query: string; limit: number }): Promise<readonly MaterialSummary[]> {
    const pattern = `%${input.query}%`;
    const rows = input.query
      ? await this.database.all<MaterialRow>({
          sql: `SELECT id,code,name,model,unit,enabled,version FROM materials
                WHERE name LIKE ? OR model LIKE ? OR code LIKE ?
                ORDER BY model COLLATE NOCASE,unit COLLATE NOCASE LIMIT ?`,
          params: [pattern, pattern, pattern, input.limit],
        })
      : await this.database.all<MaterialRow>({
          sql: `SELECT id,code,name,model,unit,enabled,version FROM materials
                ORDER BY model COLLATE NOCASE,unit COLLATE NOCASE LIMIT ?`,
          params: [input.limit],
        });
    return rows.map(summary);
  }

  async create(input: CreateMaterialRecord): Promise<void> {
    const item = input.material;
    await this.database.batch([
      {
        sql: `INSERT INTO materials (id,code,name,model,unit,enabled,version,created_by,created_at,updated_at)
              VALUES (?,?,?,?,?,1,1,?,?,?)`,
        params: [item.id, item.code, item.name, item.model, item.unit, input.actorId, input.now, input.now],
      },
      {
        sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
              VALUES (?,?,'material.create','material',?,NULL,?,?)`,
        params: [input.auditId, input.actorId, item.id, JSON.stringify(item), input.now],
      },
      {
        sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
              VALUES (?,?,?,?,?,201,?)`,
        params: [input.idempotencyKey, input.actorId, input.operation, input.requestHash, input.responseJson, input.now],
      },
    ]);
  }
}
