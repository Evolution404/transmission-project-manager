import type { CustomFieldEntityType } from '@tpm/shared';

export type MasterDataWriteKind = 'voltage-level' | 'line' | 'tower-position';
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

export interface LineTowerPositionWriteValues {
  lineId: string;
  physicalTowerId: string;
  towerNo: string;
  sortRank: number;
  positionLabel: string | null;
  enabled: boolean;
}

export interface PhysicalTowerCreateValues {
  id: string;
  assetCode: string | null;
  towerTypeId: string | null;
  maintenanceTeamId: string | null;
  enabled: boolean;
}

export type MasterConfigKind = 'team' | 'tower-type' | 'custom-field';

export interface TeamWriteValues {
  code: string | null;
  name: string;
  enabled: boolean;
}

export interface TowerTypeWriteValues {
  code: string | null;
  label: string;
  sortOrder: number;
  enabled: boolean;
}

export interface CustomFieldDefinitionWriteValues {
  entityType: CustomFieldEntityType;
  fieldKey: string;
  label: string;
  dataType: 'text' | 'integer' | 'quantity' | 'year' | 'boolean' | 'date' | 'single_select' | 'multi_select';
  required: boolean;
  filterable: boolean;
  optionsJson: string | null;
  validationJson: string;
  sortOrder: number;
  enabled: boolean;
}

export interface CommitMasterConfigInput {
  kind: MasterConfigKind;
  action: MasterDataWriteAction;
  id: string;
  values?: TeamWriteValues | TowerTypeWriteValues | CustomFieldDefinitionWriteValues;
  expectedVersion: number | null;
  mutation: MasterMutationRecord;
  audit: MasterAuditRecord;
}

export interface PhysicalTowerWriteValues {
  assetCode: string | null;
  towerTypeId: string | null;
  maintenanceTeamId: string | null;
  enabled: boolean;
}

export interface CommitPhysicalTowerUpdateInput {
  id: string;
  expectedVersion: number;
  values: PhysicalTowerWriteValues;
  mutation: MasterMutationRecord;
  audit: MasterAuditRecord;
}

export interface CommitTowerPhysicalRebindInput {
  id: string;
  expectedVersion: number;
  physicalTowerId: string;
  mutation: MasterMutationRecord;
  audit: MasterAuditRecord;
}

export interface CustomFieldValueWrite {
  fieldDefinitionId: string;
  valueJson: string;
  textValue: string | null;
  integerValue: number | null;
  dateValue: string | null;
  booleanValue: number | null;
  multiSelectValues: string[];
  filterable: boolean;
}

export interface CommitCustomFieldValuesInput {
  entityType: CustomFieldEntityType;
  entityId: string;
  expectedVersion: number | null;
  values: CustomFieldValueWrite[];
  mutation: MasterMutationRecord;
  audit: MasterAuditRecord;
}

export interface CommitSingleMasterDataInput {
  kind: MasterDataWriteKind;
  action: MasterDataWriteAction;
  id: string;
  values?: VoltageLevelWriteValues | TransmissionLineWriteValues | LineTowerPositionWriteValues;
  createPhysicalTower?: PhysicalTowerCreateValues;
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
  values: LineTowerPositionWriteValues;
  createPhysicalTower?: PhysicalTowerCreateValues;
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
  findPhysicalTower(id: string): Promise<Record<string, string | number | null> | null>;
  findCustomFieldEntity(entityType: CustomFieldEntityType, id: string): Promise<Record<string, string | number | null> | null>;
  findConfigRecord(kind: MasterConfigKind, id: string): Promise<Record<string, string | number | null> | null>;
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
  commitConfig(input: CommitMasterConfigInput): Promise<void>;
  commitPhysicalTowerUpdate(input: CommitPhysicalTowerUpdateInput): Promise<void>;
  commitTowerPhysicalRebind(input: CommitTowerPhysicalRebindInput): Promise<void>;
  commitCustomFieldValues(input: CommitCustomFieldValuesInput): Promise<void>;
}
