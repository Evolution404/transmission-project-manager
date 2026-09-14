import type {
  AlertEventSummary,
  NotificationContactSummary,
  NotificationOutboxStatus,
  NotificationOutboxSummary,
} from '@tpm/shared';
import type { OperationJournalRecord } from './operation-journal-repository';

export interface AlertEnsureInput {
  ruleKey: string;
  ruleVersion: number;
  objectType: string;
  objectId: string;
  periodKey: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  now: string;
  recipients: readonly string[];
}

export interface AlertEnsureResult {
  created: boolean;
  eventId: string;
  firstSeenAt: string;
}

export interface NotificationDeliveryEvent {
  message: string;
  ruleKey: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface NotificationResultWrite {
  row: NotificationOutboxSummary;
  leaseToken: string;
  status: NotificationOutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  error: string | null;
  updatedAt: string;
  journal?: OperationJournalRecord;
}

export interface NotificationRepository {
  memberExists(memberId: string): Promise<boolean>;
  createContact(input: { contact: NotificationContactSummary; journal: OperationJournalRecord }): Promise<void>;
  listContacts(): Promise<readonly NotificationContactSummary[]>;
  verifiedRecipients(frameworkId?: string | null, projectId?: string | null): Promise<readonly string[]>;
  ensureAlert(input: AlertEnsureInput): Promise<AlertEnsureResult>;
  ensureDailySummary(eventId: string, asOf: string, now: string, recipients: readonly string[]): Promise<void>;
  resolveActiveAlerts(input: { ruleKey: string; objectId: string; now: string; recipients: readonly string[] }): Promise<number>;
  listAlerts(limit: number): Promise<readonly AlertEventSummary[]>;
  claimOutbox(now: string, limit: number, leaseSeconds: number): Promise<readonly NotificationOutboxSummary[]>;
  listOutbox(limit: number): Promise<readonly NotificationOutboxSummary[]>;
  findOutbox(id: string): Promise<NotificationOutboxSummary | null>;
  findDeliveryEvent(eventId: string): Promise<NotificationDeliveryEvent | null>;
  completeOutboxLease(input: NotificationResultWrite): Promise<{ changed: boolean }>;
}
