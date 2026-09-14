export interface OperationJournalRecord {
  auditId: string;
  actorId: string;
  action: string;
  objectType: string;
  objectId: string;
  before: unknown;
  after: unknown;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
  statusCode: number;
  now: string;
}

export interface OperationJournalRepository {
  record(input: OperationJournalRecord): Promise<void>;
}
