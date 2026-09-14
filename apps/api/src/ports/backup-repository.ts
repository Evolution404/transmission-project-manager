import type { BackupKind, BackupSummary } from '@tpm/shared';
import type { DatabaseValue } from './database';

export const BACKUP_TABLES = [
  'members', 'member_scopes', 'settings_versions', 'dictionary_items', 'audit_events', 'idempotency_records',
  'voltage_levels', 'transmission_lines', 'transmission_towers',
  'materials', 'import_mapping_templates', 'import_batches', 'import_rows', 'demands', 'demand_source_rows', 'demand_materials', 'field_definitions',
  'projects', 'project_versions', 'demand_allocations', 'project_cost_lines', 'reserve_categories', 'category_mappings', 'category_cost_allocations',
  'project_demand_links', 'project_material_requirements', 'project_material_revisions',
  'frameworks', 'framework_versions', 'agreements', 'agreement_versions', 'project_budgets', 'budget_allocations', 'budget_versions',
  'budget_version_allocations', 'financial_entries', 'financial_entry_allocations',
  'project_releases', 'project_tasks', 'task_demand_scopes', 'task_material_requirements', 'material_supply_events',
  'task_implementation_records', 'task_implementation_scope_lines', 'task_material_usage_lines',
  'task_settlements', 'task_settlement_scope_lines', 'task_settlement_agreement_allocations', 'task_settlement_reminders',
  'release_batches', 'release_lines', 'implementation_records', 'implementation_lines', 'settlements', 'settlement_coverage',
  'settlement_agreement_allocations', 'attachments',
  'analysis_rules', 'monthly_plans', 'report_snapshots', 'annual_milestones', 'notification_contacts', 'alert_events', 'notification_outbox',
] as const;

export type BackupTableName = (typeof BACKUP_TABLES)[number];

export interface BackupChunkState {
  id: string;
  backupRunId: string;
  tableName: BackupTableName;
  chunkIndex: number;
  objectKey: string;
  rowCount: number;
  sha256: string;
  createdAt: string;
}

export interface BackupTableRow extends Record<string, DatabaseValue> {
  __rowid: number;
}

export interface BackupRetentionCandidate {
  id: string;
  manifestKey: string | null;
}

export interface BackupRepository {
  ensure(backupDate: string, kind: BackupKind, now: string): Promise<{ created: boolean; backup: BackupSummary }>;
  find(id: string): Promise<BackupSummary | null>;
  list(limit: number): Promise<readonly BackupSummary[]>;
  listChunks(backupRunId: string): Promise<readonly BackupChunkState[]>;
  listAttachmentKeys(): Promise<readonly string[]>;
  readTableRows(table: BackupTableName, afterRowid: number, limit: number): Promise<readonly BackupTableRow[]>;
  advanceEmptyTable(backupId: string, startedAt: string, now: string): Promise<void>;
  nextChunkIndex(backupId: string, table: BackupTableName): Promise<number>;
  recordChunk(input: { backupId: string; table: BackupTableName; chunkIndex: number; objectKey: string; rowCount: number; sha256: string; nextTableIndex: number; nextCursorRowid: number; startedAt: string; now: string }): Promise<void>;
  markCompleted(backupId: string, manifestKey: string, now: string): Promise<void>;
  markFailed(backupId: string, error: string, now: string): Promise<void>;
  markVerified(backupId: string, now: string): Promise<void>;
  retentionCandidates(kind: BackupKind, keep: number): Promise<readonly BackupRetentionCandidate[]>;
  chunkObjectKeys(backupId: string): Promise<readonly string[]>;
  deleteRun(backupId: string): Promise<void>;
  findPending(): Promise<string | null>;
}
