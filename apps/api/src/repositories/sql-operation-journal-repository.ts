import type { DatabasePort } from '../ports/database';
import type { OperationJournalRecord, OperationJournalRepository } from '../ports/operation-journal-repository';

export class SqlOperationJournalRepository implements OperationJournalRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async record(input: OperationJournalRecord): Promise<void> {
    await this.database.batch([
      {
        sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?)`,
        params: [
          input.auditId,
          input.actorId,
          input.action,
          input.objectType,
          input.objectId,
          input.before === null ? null : JSON.stringify(input.before),
          input.after === null ? null : JSON.stringify(input.after),
          input.now,
        ],
      },
      {
        sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at) VALUES (?,?,?,?,?,?,?)`,
        params: [input.idempotencyKey, input.actorId, input.operation, input.requestHash, input.responseJson, input.statusCode, input.now],
      },
    ]);
  }
}
