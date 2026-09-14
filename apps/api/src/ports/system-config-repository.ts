import type { DictionaryItem, SettingVersion } from '@tpm/shared';

export interface SettingWriteRecord {
  id: string;
  key: string;
  version: number;
  valueJson: string;
  effectiveFrom: string;
  createdBy: string;
  createdAt: string;
}

export interface SettingWriteMetadata {
  auditId: string;
  actorId: string;
  beforeJson: string;
  afterJson: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
  statusCode: number;
}

export interface SystemConfigRepository {
  listCurrentSettings(): Promise<SettingVersion[]>;
  getSettingHistory(key: string): Promise<SettingVersion[]>;
  listDictionary(key?: string): Promise<DictionaryItem[]>;
  currentSettingVersion(key: string): Promise<number | null>;
  createSettingVersion(record: SettingWriteRecord, metadata: SettingWriteMetadata): Promise<void>;
}
