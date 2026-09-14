import type { CategoryMappingSummary, ReserveCategorySummary } from '@tpm/shared';
import type { DatabasePort, DatabaseStatement } from '../ports/database.ts';
import type { CreateReserveCategoryRecord, ReserveCategoryWriteRepository, UpsertCategoryMappingRecord } from '../ports/reserve-category-write-repository.ts';

type CategoryRow = { id: string; category_key: string; label: string; enabled: number; version: number };
type MappingRow = { id: string; demand_category_key: string; reserve_category_id: string; version: number };

function categorySummary(row: CategoryRow): ReserveCategorySummary {
  return { id: row.id, key: row.category_key, label: row.label, enabled: row.enabled === 1, version: row.version };
}

function mappingSummary(row: MappingRow): CategoryMappingSummary {
  return { id: row.id, demandCategory: row.demand_category_key, reserveCategoryId: row.reserve_category_id, version: row.version };
}

export class SqlReserveCategoryWriteRepository implements ReserveCategoryWriteRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async findCategory(id: string): Promise<ReserveCategorySummary | null> {
    const row = await this.database.first<CategoryRow>({
      sql: 'SELECT id,category_key,label,enabled,version FROM reserve_categories WHERE id=? LIMIT 1',
      params: [id],
    });
    return row ? categorySummary(row) : null;
  }

  async findMapping(demandCategory: string): Promise<CategoryMappingSummary | null> {
    const row = await this.database.first<MappingRow>({
      sql: `SELECT id,demand_category_key,reserve_category_id,version
            FROM category_mappings WHERE demand_category_key=? COLLATE NOCASE LIMIT 1`,
      params: [demandCategory],
    });
    return row ? mappingSummary(row) : null;
  }

  async createCategory(input: CreateReserveCategoryRecord): Promise<void> {
    const item = input.category;
    await this.database.batch([
      {
        sql: `INSERT INTO reserve_categories (id,category_key,label,enabled,version,created_by,created_at,updated_at)
              VALUES (?,?,?,1,1,?,?,?)`,
        params: [item.id, item.key, item.label, input.actorId, input.now, input.now],
      },
      {
        sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
              VALUES (?,?,'reserve_category.create','reserve_category',?,NULL,?,?)`,
        params: [input.auditId, input.actorId, item.id, JSON.stringify(item), input.now],
      },
      {
        sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
              VALUES (?,?,?,?,?,201,?)`,
        params: [input.idempotencyKey, input.actorId, input.operation, input.requestHash, input.responseJson, input.now],
      },
    ]);
  }

  async upsertMapping(input: UpsertCategoryMappingRecord): Promise<void> {
    const item = input.mapping;
    const statements: DatabaseStatement[] = [];
    if (input.before) {
      statements.push({
        sql: `UPDATE category_mappings
              SET reserve_category_id=?,version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END
              WHERE id=?`,
        params: [item.reserveCategoryId, input.expectedVersion, input.now, item.id],
      });
    } else {
      statements.push({
        sql: `INSERT INTO category_mappings (id,demand_category_key,reserve_category_id,version,created_by,created_at,updated_at)
              VALUES (?,?,?,1,?,?,?)`,
        params: [item.id, item.demandCategory, item.reserveCategoryId, input.actorId, input.now, input.now],
      });
    }
    statements.push({
      sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,'category_mapping.upsert','category_mapping',?,?,?,?)`,
      params: [
        input.auditId,
        input.actorId,
        item.id,
        input.before ? JSON.stringify(input.before) : null,
        JSON.stringify(item),
        input.now,
      ],
    }, {
      sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (?,?,?,?,?,200,?)`,
      params: [input.idempotencyKey, input.actorId, input.operation, input.requestHash, input.responseJson, input.now],
    });
    await this.database.batch(statements);
  }
}
