import type { TransmissionLineSummary, TransmissionTowerSummary, VoltageLevelSummary } from '@tpm/shared';

export interface LinePageCursor {
  lineName: string;
  id: string;
}

export interface TowerPageCursor {
  sortIndex: number;
  id: string;
}

export interface MasterDataRepository {
  listVoltageLevels(): Promise<readonly VoltageLevelSummary[]>;
  listLines(input: { voltageLevelId: string | null; cursor: LinePageCursor | null; limit: number }): Promise<readonly TransmissionLineSummary[]>;
  listTowers(input: { lineId: string | null; cursor: TowerPageCursor | null; limit: number }): Promise<readonly TransmissionTowerSummary[]>;
}
