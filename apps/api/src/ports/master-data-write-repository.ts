export type MasterDataWriteKind = 'voltage-level' | 'line' | 'tower';
export type MasterDataWriteAction = 'create' | 'update' | 'delete';

export interface MasterMutationRecord {
  key: string;
  actorId: string;
  operation: string;
  hash: string;
  responseJson: string;
  statusCode: 200 | 201;
  now: string;
  auditId: string;
}

export interface MasterAuditRecord {
  action: string;
  objectType: string;
  before: unknown;
  after: unknown;
}

export interface VoltageLevelWriteValues {
  code: string;
  displayName: string;
  systemType: 'AC' | 'DC';
  nominalKv: number;
  sortOrder: number;
  enabled: boolean;
}

export interface TransmissionLineWriteValues {
  voltageLevelId: string;
  lineName: string;
  lineCode: string | null;
  enabled: boolean;
}

export interface TransmissionTowerWriteValues {
  lineId: string;
  towerNo: string;
  sortRank: number;
  towerType: string | null;
  enabled: boolean;
}

export interface CommitSingleMasterDataInput {
  kind: MasterDataWriteKind;
  action: MasterDataWriteAction;
  id: string;
  values?: VoltageLevelWriteValues | TransmissionLineWriteValues | TransmissionTowerWriteValues;
  expectedVersion: number | null;
  requireEnabledParent?: boolean;
  parentLineId?: string;
  expectedTowerOrderVersion?: number;
  changesTowerOrder?: boolean;
  rebalanceTowerOrder?: boolean;
  mutation: MasterMutationRecord;
  audit: MasterAuditRecord;
}

export interface CommitLineRenameInput {
  id: string;
  expectedVersion: number;
  lineName: string;
  historyId: string;
  reason: string | null;
  mutation: MasterMutationRecord;
  audit: MasterAuditRecord;
}

export interface CommitTowerRenameInput {
  id: string;
  expectedVersion: number;
  towerNo: string;
  historyId: string;
  reason: string | null;
  mutation: MasterMutationRecord;
  audit: MasterAuditRecord;
}

export interface CommitTowerMoveInput {
  lineId: string;
  towerId: string;
  targetTowerId: string;
  placement: 'before' | 'after';
  expectedTowerOrderVersion: number;
  rebalance: boolean;
  mutation: MasterMutationRecord;
  audit: MasterAuditRecord;
}

export interface TowerImportChunkWriteItem {
  action: 'create' | 'update';
  id: string;
  expectedVersion: number | null;
  values: TransmissionTowerWriteValues;
}

export interface CommitTowerImportChunkInput {
  lineId: string;
  expectedTowerOrderVersion: number;
  changesTowerOrder: boolean;
  rebalanceTowerOrder: boolean;
  items: TowerImportChunkWriteItem[];
  mutation: MasterMutationRecord;
  audit: MasterAuditRecord;
}

export interface CommitTowerReorderInput {
  lineId: string;
  expectedTowerOrderVersion: number;
  towerIds: string[];
  mutation: MasterMutationRecord;
  audit: MasterAuditRecord;
}

export interface MasterDataWriteRepository {
  findRecord(kind: MasterDataWriteKind, id: string): Promise<Record<string, string | number | null> | null>;
  findTowerRecords(ids: readonly string[]): Promise<readonly Record<string, string | number | null>[]>;
  findVoltageParent(id: string): Promise<{ displayName: string; enabled: boolean } | null>;
  findTowerParent(lineId: string): Promise<{ lineName: string; enabled: boolean; voltageEnabled: boolean; towerOrderVersion: number } | null>;
  listTowerOrder(lineId: string): Promise<readonly { id: string; towerNo: string; sortRank: number }[]>;
  countLineTowers(lineId: string): Promise<number>;
  commitSingle(input: CommitSingleMasterDataInput): Promise<void>;
  commitLineRename(input: CommitLineRenameInput): Promise<void>;
  commitTowerRename(input: CommitTowerRenameInput): Promise<void>;
  commitTowerMove(input: CommitTowerMoveInput): Promise<void>;
  commitTowerImportChunk(input: CommitTowerImportChunkInput): Promise<void>;
  commitTowerReorder(input: CommitTowerReorderInput): Promise<void>;
}
