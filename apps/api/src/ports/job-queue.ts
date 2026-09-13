export type JobPayload = Readonly<Record<string, unknown>>;

export interface JobMessage {
  jobId: string;
  type: string;
  payload: JobPayload;
  attempt: number;
}

export interface JobQueuePort {
  enqueue(message: JobMessage): Promise<void>;
  enqueueBatch(messages: readonly JobMessage[]): Promise<void>;
}
