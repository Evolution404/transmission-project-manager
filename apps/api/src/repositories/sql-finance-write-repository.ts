import type { DatabasePort, DatabaseStatement } from '../ports/database.ts';
import type {
  CreateAgreementRecord,
  CreateFrameworkRecord,
  FinanceWriteRepository,
  UpdateAgreementRecord,
  UpdateFrameworkRecord,
} from '../ports/finance-write-repository.ts';

function auditStatement(input: { id: string; actorId: string; action: string; type: string; objectId: string; before: unknown; after: unknown; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    params: [input.id, input.actorId, input.action, input.type, input.objectId,
      input.before === null ? null : JSON.stringify(input.before),
      input.after === null ? null : JSON.stringify(input.after), input.now],
  };
}

function idempotencyStatement(input: { key: string; actorId: string; operation: string; hash: string; responseJson: string; status: number; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,?,?,?,?)`,
    params: [input.key, input.actorId, input.operation, input.hash, input.responseJson, input.status, input.now],
  };
}

export class SqlFinanceWriteRepository implements FinanceWriteRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async createFramework(input: CreateFrameworkRecord): Promise<void> {
    const item = input.framework;
    await this.database.batch([
      {
        sql: `INSERT INTO frameworks
              (id,code,name,total_amount_fen,annual_target_fen,start_date,end_date,version,created_by,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,1,?,?,?)`,
        params: [item.id, item.code, item.name, item.totalAmountFen, item.annualTargetFen, item.startDate, item.endDate, input.actorId, item.createdAt, item.updatedAt],
      },
      {
        sql: `INSERT INTO framework_versions
              (id,framework_id,version,code,name,total_amount_fen,annual_target_fen,start_date,end_date,reason,created_by,created_at)
              VALUES (?,?,1,?,?,?,?,?,?,NULL,?,?)`,
        params: [input.versionId, item.id, item.code, item.name, item.totalAmountFen, item.annualTargetFen, item.startDate, item.endDate, input.actorId, item.createdAt],
      },
      auditStatement({ id: input.auditId, actorId: input.actorId, action: 'framework.create', type: 'framework', objectId: item.id, before: null, after: item, now: item.createdAt }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, status: 201, now: item.createdAt }),
    ]);
  }

  async updateFramework(input: UpdateFrameworkRecord): Promise<void> {
    const item = input.next;
    await this.database.batch([
      {
        sql: `UPDATE frameworks
              SET name=?,total_amount_fen=?,annual_target_fen=?,start_date=?,end_date=?,version=version+1,
                  updated_at=CASE WHEN version=? THEN ? ELSE NULL END
              WHERE id=?`,
        params: [item.name, item.totalAmountFen, item.annualTargetFen, item.startDate, item.endDate, input.expectedVersion, item.updatedAt, item.id],
      },
      {
        sql: `INSERT INTO framework_versions
              (id,framework_id,version,code,name,total_amount_fen,annual_target_fen,start_date,end_date,reason,created_by,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [input.versionId, item.id, item.version, item.code, item.name, item.totalAmountFen, item.annualTargetFen, item.startDate, item.endDate, input.reason, input.actorId, item.updatedAt],
      },
      auditStatement({ id: input.auditId, actorId: input.actorId, action: 'framework.update', type: 'framework', objectId: item.id, before: input.before, after: item, now: item.updatedAt }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, status: 200, now: item.updatedAt }),
    ]);
  }

  async createAgreement(input: CreateAgreementRecord): Promise<void> {
    const item = input.agreement;
    await this.database.batch([
      {
        sql: `INSERT INTO agreements
              (id,framework_id,code,name,amount_fen,valid_from,valid_to,status,version,created_by,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,1,?,?,?)`,
        params: [item.id, item.frameworkId, item.code, item.name, item.amountFen, item.validFrom, item.validTo, item.status, input.actorId, item.createdAt, item.updatedAt],
      },
      {
        sql: `INSERT INTO agreement_versions
              (id,agreement_id,version,framework_id,code,name,amount_fen,valid_from,valid_to,status,reason,created_by,created_at)
              VALUES (?,?,1,?,?,?,?,?,?,?,NULL,?,?)`,
        params: [input.versionId, item.id, item.frameworkId, item.code, item.name, item.amountFen, item.validFrom, item.validTo, item.status, input.actorId, item.createdAt],
      },
      auditStatement({ id: input.auditId, actorId: input.actorId, action: 'agreement.create', type: 'agreement', objectId: item.id, before: null, after: item, now: item.createdAt }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, status: 201, now: item.createdAt }),
    ]);
  }

  async updateAgreement(input: UpdateAgreementRecord): Promise<void> {
    const item = input.next;
    await this.database.batch([
      {
        sql: `UPDATE agreements
              SET name=?,amount_fen=?,valid_from=?,valid_to=?,status=?,version=version+1,
                  updated_at=CASE WHEN version=? THEN ? ELSE NULL END
              WHERE id=?`,
        params: [item.name, item.amountFen, item.validFrom, item.validTo, item.status, input.expectedVersion, item.updatedAt, item.id],
      },
      {
        sql: `INSERT INTO agreement_versions
              (id,agreement_id,version,framework_id,code,name,amount_fen,valid_from,valid_to,status,reason,created_by,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [input.versionId, item.id, item.version, item.frameworkId, item.code, item.name, item.amountFen, item.validFrom, item.validTo, item.status, input.reason, input.actorId, item.updatedAt],
      },
      auditStatement({ id: input.auditId, actorId: input.actorId, action: 'agreement.update', type: 'agreement', objectId: item.id, before: input.before, after: item, now: item.updatedAt }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, status: 200, now: item.updatedAt }),
    ]);
  }
}
