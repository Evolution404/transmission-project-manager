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
  sortIndex: number;
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
  mutation: MasterMutationRecord;
  audit: MasterAuditRecord;
}

export interface MasterDataWriteRepository {
  findRecord(kind: MasterDataWriteKind, id: string): Promise<Record<string, string | number | null> | null>;
  findVoltageParent(id: string): Promise<{ displayName: string; enabled: boolean } | null>;
  findTowerParent(lineId: string): Promise<{ lineName: string; enabled: boolean; voltageEnabled: boolean } | null>;
  countLineTowers(lineId: string): Promise<number>;
  commitSingle(input: CommitSingleMasterDataInput): Promise<void>;
}
