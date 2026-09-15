import type {
  CustomFieldEntityType,
  CustomFieldDefinitionSummary,
  CustomFieldValueSetSummary,
  LineTowerPositionNoHistoryEntry,
  LineTowerPositionSummary,
  PhysicalTowerSummary,
  TeamSummary,
  TransmissionLineNameHistoryEntry,
  TransmissionLineSummary,
  TowerTypeSummary,
  VoltageLevelSummary,
} from '@tpm/shared';

export interface LinePageCursor {
  lineName: string;
  id: string;
}

export interface TowerPageCursor {
  sortRank: number;
  id: string;
}

export interface MasterDataRepository {
  listVoltageLevels(): Promise<readonly VoltageLevelSummary[]>;
  listTeams(): Promise<readonly TeamSummary[]>;
  listTowerTypes(): Promise<readonly TowerTypeSummary[]>;
  listCustomFieldDefinitions(entityType: CustomFieldEntityType | null): Promise<readonly CustomFieldDefinitionSummary[]>;
  getCustomFieldValues(entityType: CustomFieldEntityType, entityId: string): Promise<CustomFieldValueSetSummary>;
  listPhysicalTowers(input: { query: string | null; limit: number }): Promise<readonly PhysicalTowerSummary[]>;
  listLines(input: { voltageLevelId: string | null; enabled: boolean | null; query: string | null; cursor: LinePageCursor | null; limit: number }): Promise<readonly TransmissionLineSummary[]>;
  listLineTowerPositions(input: { lineId: string | null; query: string | null; cursor: TowerPageCursor | null; limit: number }): Promise<readonly LineTowerPositionSummary[]>;
  listLineNameHistory(lineId: string): Promise<readonly TransmissionLineNameHistoryEntry[]>;
  listTowerPositionNoHistory(lineTowerPositionId: string): Promise<readonly LineTowerPositionNoHistoryEntry[]>;
}
