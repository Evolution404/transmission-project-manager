export interface IdempotencyReplayRecord {
  actorMemberId: string;
  operation: string;
  requestHash: string;
  responseJson: string;
  statusCode: number;
}

export interface IdempotencyRepository {
  findByKey(key: string): Promise<IdempotencyReplayRecord | null>;
}
