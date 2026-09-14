import type { FinancialEntryAllocationSummary, FinancialEntrySummary, FinancialEntryType } from '@tpm/shared';
import type { DatabasePort, DatabaseStatement } from '../ports/database.ts';
import type {
  CreateFinancialEntryRecord,
  FinanceEntryRepository,
  FinancialEntryListInput,
  ReverseFinancialEntryRecord,
} from '../ports/finance-entry-repository.ts';

type EntryRow = {
  id: string;
  framework_id: string;
  project_id: string;
  project_name: string;
  entry_type: FinancialEntryType;
  business_date: string;
  amount_fen: number;
  note: string | null;
  reverses_entry_id: string | null;
  created_at: string;
};

type AllocationRow = {
  financial_entry_id: string;
  agreement_id: string;
  amount_fen: number;
  code: string;
  name: string;
};

function auditStatement(input: { id: string; actorId: string; action: string; objectId: string; before: unknown; after: unknown; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    params: [
      input.id,
      input.actorId,
      input.action,
      'financial_entry',
      input.objectId,
      input.before === null ? null : JSON.stringify(input.before),
      input.after === null ? null : JSON.stringify(input.after),
      input.now,
    ],
  };
}

function idempotencyStatement(input: { key: string; actorId: string; operation: string; hash: string; responseJson: string; status: number; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,?,?,?,?)`,
    params: [input.key, input.actorId, input.operation, input.hash, input.responseJson, input.status, input.now],
  };
}

function listParams(input: FinancialEntryListInput) {
  const cursor = input.cursor;
  return [
    input.frameworkId,
    input.frameworkId,
    input.projectId,
    input.projectId,
    cursor?.businessDate ?? null,
    cursor?.businessDate ?? '',
    cursor?.businessDate ?? '',
    cursor?.createdAt ?? '',
    cursor?.businessDate ?? '',
    cursor?.createdAt ?? '',
    cursor?.id ?? '',
    input.limit,
  ] as const;
}

const LIST_FILTER = `
  WHERE (? IS NULL OR fe.framework_id=?)
    AND (? IS NULL OR fe.project_id=?)
    AND (? IS NULL OR fe.business_date < ?
      OR (fe.business_date = ? AND fe.created_at < ?)
      OR (fe.business_date = ? AND fe.created_at = ? AND fe.id < ?))
  ORDER BY fe.business_date DESC,fe.created_at DESC,fe.id DESC LIMIT ?`;

function mapEntries(rows: readonly EntryRow[], allocationRows: readonly AllocationRow[]): FinancialEntrySummary[] {
  const allocations = new Map<string, FinancialEntryAllocationSummary[]>();
  for (const row of allocationRows) {
    const list = allocations.get(row.financial_entry_id) ?? [];
    list.push({
      agreementId: row.agreement_id,
      amountFen: row.amount_fen,
      agreementCode: row.code,
      agreementName: row.name,
    });
    allocations.set(row.financial_entry_id, list);
  }
  return rows.map((row) => ({
    id: row.id,
    frameworkId: row.framework_id,
    projectId: row.project_id,
    projectName: row.project_name,
    type: row.entry_type,
    businessDate: row.business_date,
    amountFen: row.amount_fen,
    note: row.note,
    reversesEntryId: row.reverses_entry_id,
    allocations: allocations.get(row.id) ?? [],
    createdAt: row.created_at,
  }));
}

export class SqlFinanceEntryRepository implements FinanceEntryRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async listEntries(input: FinancialEntryListInput): Promise<readonly FinancialEntrySummary[]> {
    const params = listParams(input);
    const rows = await this.database.all<EntryRow>({
      sql: `SELECT fe.id,fe.framework_id,fe.project_id,p.name AS project_name,fe.entry_type,fe.business_date,fe.amount_fen,fe.note,fe.reverses_entry_id,fe.created_at
            FROM financial_entries fe INNER JOIN projects p ON p.id=fe.project_id
            ${LIST_FILTER}`,
      params,
    });
    if (!rows.length) return [];
    const allocationRows = await this.database.all<AllocationRow>({
      sql: `SELECT fea.financial_entry_id,fea.agreement_id,fea.amount_fen,a.code,a.name
            FROM financial_entry_allocations fea
            INNER JOIN agreements a ON a.id=fea.agreement_id
            INNER JOIN (
              SELECT fe.id FROM financial_entries fe
              ${LIST_FILTER}
            ) selected ON selected.id=fea.financial_entry_id
            ORDER BY fea.financial_entry_id,a.code COLLATE NOCASE,a.id`,
      params,
    });
    return mapEntries(rows, allocationRows);
  }

  async findEntry(id: string): Promise<FinancialEntrySummary | null> {
    const row = await this.database.first<EntryRow>({
      sql: `SELECT fe.id,fe.framework_id,fe.project_id,p.name AS project_name,fe.entry_type,fe.business_date,fe.amount_fen,fe.note,fe.reverses_entry_id,fe.created_at
            FROM financial_entries fe INNER JOIN projects p ON p.id=fe.project_id WHERE fe.id=? LIMIT 1`,
      params: [id],
    });
    if (!row) return null;
    const allocations = await this.database.all<AllocationRow>({
      sql: `SELECT fea.financial_entry_id,fea.agreement_id,fea.amount_fen,a.code,a.name
            FROM financial_entry_allocations fea INNER JOIN agreements a ON a.id=fea.agreement_id
            WHERE fea.financial_entry_id=? ORDER BY a.code COLLATE NOCASE,a.id`,
      params: [id],
    });
    return mapEntries([row], allocations)[0] ?? null;
  }

  async hasReversal(entryId: string): Promise<boolean> {
    const row = await this.database.first<{ id: string }>({
      sql: `SELECT id FROM financial_entries WHERE reverses_entry_id=? LIMIT 1`,
      params: [entryId],
    });
    return row !== null;
  }

  async createEntry(input: CreateFinancialEntryRecord): Promise<void> {
    const item = input.entry;
    await this.database.batch([
      {
        sql: `INSERT INTO financial_entries
              (id,framework_id,project_id,entry_type,business_date,amount_fen,note,reverses_entry_id,created_by,created_at)
              VALUES (?,?,?,?,?,?,?,NULL,?,?)`,
        params: [item.id, item.frameworkId, item.projectId, item.type, item.businessDate, item.amountFen, item.note, input.actorId, item.createdAt],
      },
      ...input.allocations.map((allocation) => ({
        sql: `INSERT INTO financial_entry_allocations (id,financial_entry_id,agreement_id,amount_fen,created_at) VALUES (?,?,?,?,?)`,
        params: [allocation.id, item.id, allocation.agreementId, allocation.amountFen, item.createdAt],
      })),
      auditStatement({ id: input.auditId, actorId: input.actorId, action: 'financial-entry.create', objectId: item.id, before: null, after: item, now: item.createdAt }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, status: 201, now: item.createdAt }),
    ]);
  }

  async reverseEntry(input: ReverseFinancialEntryRecord): Promise<void> {
    const item = input.reversal;
    await this.database.batch([
      {
        sql: `INSERT INTO financial_entries
              (id,framework_id,project_id,entry_type,business_date,amount_fen,note,reverses_entry_id,created_by,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        params: [item.id, item.frameworkId, item.projectId, item.type, item.businessDate, item.amountFen, item.note, item.reversesEntryId, input.actorId, item.createdAt],
      },
      ...input.allocations.map((allocation) => ({
        sql: `INSERT INTO financial_entry_allocations (id,financial_entry_id,agreement_id,amount_fen,created_at) VALUES (?,?,?,?,?)`,
        params: [allocation.id, item.id, allocation.agreementId, allocation.amountFen, item.createdAt],
      })),
      auditStatement({
        id: input.auditId,
        actorId: input.actorId,
        action: 'financial-entry.reverse',
        objectId: input.original.id,
        before: { amountFen: input.original.amountFen },
        after: item,
        now: item.createdAt,
      }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, status: 201, now: item.createdAt }),
    ]);
  }
}
