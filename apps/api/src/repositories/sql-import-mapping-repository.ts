import type { ImportFieldMapping, ImportMappingTemplate } from '@tpm/shared';
import type { DatabasePort } from '../ports/database.ts';
import type { CreateImportMappingRecord, ImportMappingRepository } from '../ports/import-mapping-repository.ts';

type MappingRow = {
  id: string;
  name: string;
  mapping_json: string;
  version: number;
  created_at: string;
  updated_at: string;
};

function parseMapping(value: string): ImportFieldMapping {
  return JSON.parse(value) as ImportFieldMapping;
}

function summary(row: MappingRow): ImportMappingTemplate {
  return {
    id: row.id,
    name: row.name,
    mapping: parseMapping(row.mapping_json),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqlImportMappingRepository implements ImportMappingRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async list(): Promise<readonly ImportMappingTemplate[]> {
    const rows = await this.database.all<MappingRow>({
      sql: `SELECT id,name,mapping_json,version,created_at,updated_at
            FROM import_mapping_templates ORDER BY name COLLATE NOCASE LIMIT 100`,
    });
    return rows.map(summary);
  }

  async create(input: CreateImportMappingRecord): Promise<void> {
    const mappingJson = JSON.stringify(input.template.mapping);
    await this.database.batch([
      {
        sql: `INSERT INTO import_mapping_templates (id,name,mapping_json,version,created_by,created_at,updated_at)
              VALUES (?,?,?,1,?,?,?)`,
        params: [input.template.id, input.template.name, mappingJson, input.actorId, input.template.createdAt, input.template.updatedAt],
      },
      {
        sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
              VALUES (?,?,'import_mapping.create','import_mapping',?,NULL,?,?)`,
        params: [input.auditId, input.actorId, input.template.id, JSON.stringify(input.template), input.template.createdAt],
      },
      {
        sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
              VALUES (?,?,?,?,?,201,?)`,
        params: [input.idempotencyKey, input.actorId, input.operation, input.requestHash, input.responseJson, input.template.createdAt],
      },
    ]);
  }
}
