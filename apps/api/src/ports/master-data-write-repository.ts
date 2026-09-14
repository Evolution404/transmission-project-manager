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

export interface TowerBatchWriteItem {
  id: string;
  expectedVersion: number | null;
  vacateUniqueKeys: boolean;
  values: TransmissionTowerWriteValues;
}

export interface CommitTowerBatchInput {
  lineId: string;
  items: TowerBatchWriteItem[];
  mutation: MasterMutationRecord;
  audit: { before: unknown; after: unknown };
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

export interface MasterDataWriteRepository {
  findRecord(kind: MasterDataWriteKind, id: string): Promise<Record<string, string | number | null> | null>;
  findTowerRecords(ids: readonly string[]): Promise<readonly Record<string, string | number | null>[]>;
  findVoltageParent(id: string): Promise<{ displayName: string; enabled: boolean } | null>;
  findTowerParent(lineId: string): Promise<{ lineName: string; enabled: boolean; voltageEnabled: boolean; towerOrderVersion: number } | null>;
  findLastTowerRank(lineId: string): Promise<number>;
  listTowerOrder(lineId: string): Promise<readonly { id: string; towerNo: string; sortRank: number }[]>;
  countLineTowers(lineId: string): Promise<number>;
  commitSingle(input: CommitSingleMasterDataInput): Promise<void>;
  commitTowerBatch(input: CommitTowerBatchInput): Promise<void>;
  commitLineRename(input: CommitLineRenameInput): Promise<void>;
  commitTowerRename(input: CommitTowerRenameInput): Promise<void>;
  commitTowerMove(input: CommitTowerMoveInput): Promise<void>;
}
