import type {
  TransmissionLineNameHistoryEntry,
  TransmissionLineSummary,
  TransmissionTowerNoHistoryEntry,
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
  tower_order_version: number;
  tower_count: number;
  matched_historical_name: string | null;
};

type TowerRow = {
  id: string;
  line_id: string;
  line_name: string;
  tower_no: string;
  sort_rank: number;
  tower_type: string | null;
  enabled: number;
  version: number;
  matched_historical_no: string | null;
};

type LineHistoryRow = {
  id: string;
  line_id: string;
  line_name: string;
  valid_from: string;
  valid_to: string;
  changed_by: string;
  change_reason: string | null;
};

type TowerHistoryRow = {
  id: string;
  tower_id: string;
  line_id: string;
  tower_no: string;
  valid_from: string;
  valid_to: string;
  changed_by: string;
  change_reason: string | null;
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
    towerOrderVersion: row.tower_order_version,
    towerCount: Number(row.tower_count),
    matchedHistoricalName: row.matched_historical_name,
  };
}

function towerSummary(row: TowerRow): TransmissionTowerSummary {
  return {
    id: row.id,
    lineId: row.line_id,
    lineName: row.line_name,
    towerNo: row.tower_no,
    sortRank: row.sort_rank,
    towerType: row.tower_type,
    enabled: Boolean(row.enabled),
    version: row.version,
    matchedHistoricalNo: row.matched_historical_no,
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

  async listLines(input: { voltageLevelId: string | null; enabled: boolean | null; query: string | null; cursor: { lineName: string; id: string } | null; limit: number }): Promise<readonly TransmissionLineSummary[]> {
    const conditions: string[] = [];
    const params: DatabaseValue[] = [];
    if (input.voltageLevelId) {
      conditions.push('l.voltage_level_id=?');
      params.push(input.voltageLevelId);
    }
    if (input.enabled !== null) {
      conditions.push('l.enabled=?');
      params.push(input.enabled ? 1 : 0);
    }
    const queryPattern = input.query ? `%${input.query}%` : null;
    if (queryPattern) {
      conditions.push(`(l.line_name LIKE ? COLLATE NOCASE OR EXISTS (
        SELECT 1 FROM transmission_line_name_history h
        WHERE h.line_id=l.id AND h.line_name LIKE ? COLLATE NOCASE
      ))`);
      params.push(queryPattern, queryPattern);
    }
    if (input.cursor) {
      conditions.push('(l.line_name COLLATE NOCASE > ? OR (l.line_name=? COLLATE NOCASE AND l.id>?))');
      params.push(input.cursor.lineName, input.cursor.lineName, input.cursor.id);
    }
    const rows = await this.database.all<LineRow>({
      sql: `SELECT l.id,l.voltage_level_id,l.line_code,l.line_name,l.enabled,l.version,l.tower_order_version,
                   v.display_name AS voltage_level_name,
                   COALESCE(tc.tower_count,0) AS tower_count,
                   ${queryPattern ? `(CASE WHEN l.line_name LIKE ? COLLATE NOCASE THEN NULL ELSE (
                     SELECT h.line_name FROM transmission_line_name_history h
                     WHERE h.line_id=l.id AND h.line_name LIKE ? COLLATE NOCASE
                     ORDER BY h.valid_to DESC,h.id DESC LIMIT 1
                   ) END)` : 'NULL'} AS matched_historical_name
            FROM transmission_lines l
            JOIN voltage_levels v ON v.id=l.voltage_level_id
            LEFT JOIN (
              SELECT line_id,COUNT(*) AS tower_count
              FROM transmission_towers
              GROUP BY line_id
            ) tc ON tc.line_id=l.id
            ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
            ORDER BY l.line_name COLLATE NOCASE,l.id LIMIT ?`,
      params: [...(queryPattern ? [queryPattern, queryPattern] : []), ...params, input.limit + 1],
    });
    return rows.map(lineSummary);
  }

  async listTowers(input: { lineId: string | null; query: string | null; cursor: { sortRank: number; id: string } | null; limit: number }): Promise<readonly TransmissionTowerSummary[]> {
    const conditions: string[] = [];
    const params: DatabaseValue[] = [];
    if (input.lineId) {
      conditions.push('t.line_id=?');
      params.push(input.lineId);
    }
    if (input.query) {
      conditions.push(`(t.tower_no=? COLLATE NOCASE OR EXISTS (
        SELECT 1 FROM transmission_tower_no_history h
        WHERE h.tower_id=t.id AND h.tower_no=? COLLATE NOCASE
      ))`);
      params.push(input.query, input.query);
    }
    if (input.cursor) {
      conditions.push('(t.sort_rank>? OR (t.sort_rank=? AND t.id>?))');
      params.push(input.cursor.sortRank, input.cursor.sortRank, input.cursor.id);
    }
    const rows = await this.database.all<TowerRow>({
      sql: `SELECT t.id,t.line_id,t.tower_no,t.sort_rank,t.tower_type,t.enabled,t.version,l.line_name,
                   ${input.query ? `(CASE WHEN t.tower_no=? COLLATE NOCASE THEN NULL ELSE (
                     SELECT h.tower_no FROM transmission_tower_no_history h
                     WHERE h.tower_id=t.id AND h.tower_no=? COLLATE NOCASE
                     ORDER BY h.valid_to DESC,h.id DESC LIMIT 1
                   ) END)` : 'NULL'} AS matched_historical_no
            FROM transmission_towers t
            JOIN transmission_lines l ON l.id=t.line_id
            ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
            ORDER BY t.sort_rank,t.id LIMIT ?`,
      params: [...(input.query ? [input.query, input.query] : []), ...params, input.limit + 1],
    });
    return rows.map(towerSummary);
  }

  async listLineNameHistory(lineId: string): Promise<readonly TransmissionLineNameHistoryEntry[]> {
    const rows = await this.database.all<LineHistoryRow>({
      sql: `SELECT id,line_id,line_name,valid_from,valid_to,changed_by,change_reason
            FROM transmission_line_name_history WHERE line_id=? ORDER BY valid_to DESC,id DESC`,
      params: [lineId],
    });
    return rows.map((row) => ({
      id: row.id, lineId: row.line_id, lineName: row.line_name, validFrom: row.valid_from,
      validTo: row.valid_to, changedBy: row.changed_by, reason: row.change_reason,
    }));
  }

  async listTowerNoHistory(towerId: string): Promise<readonly TransmissionTowerNoHistoryEntry[]> {
    const rows = await this.database.all<TowerHistoryRow>({
      sql: `SELECT id,tower_id,line_id,tower_no,valid_from,valid_to,changed_by,change_reason
            FROM transmission_tower_no_history WHERE tower_id=? ORDER BY valid_to DESC,id DESC`,
      params: [towerId],
    });
    return rows.map((row) => ({
      id: row.id, towerId: row.tower_id, lineId: row.line_id, towerNo: row.tower_no,
      validFrom: row.valid_from, validTo: row.valid_to, changedBy: row.changed_by, reason: row.change_reason,
    }));
  }
}
