import type {
  TransmissionLineSummary,
  TransmissionTowerSummary,
  VoltageLevelSummary,
  VoltageSystemType,
} from '@tpm/shared';
import type { DatabasePort, DatabaseValue } from '../ports/database.ts';
import type { MasterDataRepository } from '../ports/master-data-repository.ts';

type VoltageRow = {
  id: string;
  code: string;
  display_name: string;
  system_type: VoltageSystemType;
  nominal_kv: number;
  sort_order: number;
  enabled: number;
  version: number;
};

type LineRow = {
  id: string;
  voltage_level_id: string;
  voltage_level_name: string;
  line_code: string | null;
  line_name: string;
  enabled: number;
  version: number;
  tower_count: number;
};

type TowerRow = {
  id: string;
  line_id: string;
  line_name: string;
  tower_no: string;
  sort_index: number;
  tower_type: string | null;
  enabled: number;
  version: number;
};

function voltageSummary(row: VoltageRow): VoltageLevelSummary {
  return {
    id: row.id,
    code: row.code,
    displayName: row.display_name,
    systemType: row.system_type,
    nominalKv: row.nominal_kv,
    sortOrder: row.sort_order,
    enabled: Boolean(row.enabled),
    version: row.version,
  };
}

function lineSummary(row: LineRow): TransmissionLineSummary {
  return {
    id: row.id,
    voltageLevelId: row.voltage_level_id,
    voltageLevelName: row.voltage_level_name,
    lineCode: row.line_code,
    lineName: row.line_name,
    enabled: Boolean(row.enabled),
    version: row.version,
    towerCount: Number(row.tower_count),
  };
}

function towerSummary(row: TowerRow): TransmissionTowerSummary {
  return {
    id: row.id,
    lineId: row.line_id,
    lineName: row.line_name,
    towerNo: row.tower_no,
    sortIndex: row.sort_index,
    towerType: row.tower_type,
    enabled: Boolean(row.enabled),
    version: row.version,
  };
}

export class SqlMasterDataRepository implements MasterDataRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async listVoltageLevels(): Promise<readonly VoltageLevelSummary[]> {
    const rows = await this.database.all<VoltageRow>({
      sql: `SELECT id,code,display_name,system_type,nominal_kv,sort_order,enabled,version
            FROM voltage_levels ORDER BY sort_order,nominal_kv,display_name`,
    });
    return rows.map(voltageSummary);
  }

  async listLines(input: { voltageLevelId: string | null; cursor: { lineName: string; id: string } | null; limit: number }): Promise<readonly TransmissionLineSummary[]> {
    const conditions: string[] = [];
    const params: DatabaseValue[] = [];
    if (input.voltageLevelId) {
      conditions.push('l.voltage_level_id=?');
      params.push(input.voltageLevelId);
    }
    if (input.cursor) {
      conditions.push('(l.line_name COLLATE NOCASE > ? OR (l.line_name=? COLLATE NOCASE AND l.id>?))');
      params.push(input.cursor.lineName, input.cursor.lineName, input.cursor.id);
    }
    const rows = await this.database.all<LineRow>({
      sql: `SELECT l.id,l.voltage_level_id,l.line_code,l.line_name,l.enabled,l.version,
                   v.display_name AS voltage_level_name,
                   (SELECT COUNT(*) FROM transmission_towers t WHERE t.line_id=l.id) AS tower_count
            FROM transmission_lines l
            JOIN voltage_levels v ON v.id=l.voltage_level_id
            ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
            ORDER BY l.line_name COLLATE NOCASE,l.id LIMIT ?`,
      params: [...params, input.limit + 1],
    });
    return rows.map(lineSummary);
  }

  async listTowers(input: { lineId: string | null; cursor: { sortIndex: number; id: string } | null; limit: number }): Promise<readonly TransmissionTowerSummary[]> {
    const conditions: string[] = [];
    const params: DatabaseValue[] = [];
    if (input.lineId) {
      conditions.push('t.line_id=?');
      params.push(input.lineId);
    }
    if (input.cursor) {
      conditions.push('(t.sort_index>? OR (t.sort_index=? AND t.id>?))');
      params.push(input.cursor.sortIndex, input.cursor.sortIndex, input.cursor.id);
    }
    const rows = await this.database.all<TowerRow>({
      sql: `SELECT t.id,t.line_id,t.tower_no,t.sort_index,t.tower_type,t.enabled,t.version,l.line_name
            FROM transmission_towers t
            JOIN transmission_lines l ON l.id=t.line_id
            ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
            ORDER BY t.sort_index,t.id LIMIT ?`,
      params: [...params, input.limit + 1],
    });
    return rows.map(towerSummary);
  }
}
