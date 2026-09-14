export type AttachmentObjectType = 'project' | 'release' | 'implementation' | 'settlement';

export interface AttachmentRecord {
  id: string;
  projectId: string;
  objectType: AttachmentObjectType;
  objectId: string;
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface AttachmentIdempotencyRecord {
  key: string;
  actorId: string;
  operation: string;
  requestHash: string;
  responseJson: string;
  statusCode: number;
  createdAt: string;
}

export interface CreateAttachmentRecord {
  record: AttachmentRecord;
  uploadedBy: string;
  auditEventId: string;
  idempotency: AttachmentIdempotencyRecord;
}

export interface AttachmentRepository {
  resolveObjectProject(objectType: AttachmentObjectType, objectId: string): Promise<string | null>;
  create(input: CreateAttachmentRecord): Promise<void>;
  listByObject(objectType: AttachmentObjectType, objectId: string, limit: number): Promise<readonly AttachmentRecord[]>;
  findById(id: string): Promise<AttachmentRecord | null>;
}
