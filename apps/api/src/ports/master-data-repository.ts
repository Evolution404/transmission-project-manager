import type {
  TransmissionLineNameHistoryEntry,
  TransmissionLineSummary,
  TransmissionTowerNoHistoryEntry,
  TransmissionTowerSummary,
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
  listLines(input: { voltageLevelId: string | null; enabled: boolean | null; query: string | null; cursor: LinePageCursor | null; limit: number }): Promise<readonly TransmissionLineSummary[]>;
  listTowers(input: { lineId: string | null; query: string | null; cursor: TowerPageCursor | null; limit: number }): Promise<readonly TransmissionTowerSummary[]>;
  listLineNameHistory(lineId: string): Promise<readonly TransmissionLineNameHistoryEntry[]>;
  listTowerNoHistory(towerId: string): Promise<readonly TransmissionTowerNoHistoryEntry[]>;
}
