import type { DatabasePort } from '../ports/database.ts';
import type { IdempotencyReplayRecord, IdempotencyRepository } from '../ports/idempotency-repository.ts';

type IdempotencyRow = {
  actor_member_id: string;
  operation: string;
  request_hash: string;
  response_json: string;
  status_code: number;
};

export class SqlIdempotencyRepository implements IdempotencyRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async findByKey(key: string): Promise<IdempotencyReplayRecord | null> {
    const row = await this.database.first<IdempotencyRow>({
      sql: `SELECT actor_member_id,operation,request_hash,response_json,status_code
            FROM idempotency_records WHERE idempotency_key=? LIMIT 1`,
      params: [key],
    });
    return row ? {
      actorMemberId: row.actor_member_id,
      operation: row.operation,
      requestHash: row.request_hash,
      responseJson: row.response_json,
      statusCode: row.status_code,
    } : null;
  }
}
