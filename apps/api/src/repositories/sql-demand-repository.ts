import type { MaterialSummary } from '@tpm/shared';
import type { DatabasePort } from '../ports/database.ts';
import type { DemandRepository, ResolvedDemandLine, ResolvedDemandTower } from '../ports/demand-repository.ts';

type LineRow = {
  id: string;
  line_name: string;
  enabled: number;
  voltage_level_id: string;
  voltage_name: string;
  voltage_enabled: number;
};

type TowerRow = {
  id: string;
  tower_no: string;
  sort_index: number;
  line_id: string;
  enabled: number;
};

type MaterialRow = {
  id: string;
  code: string | null;
  name: string;
  model: string;
  unit: string;
  enabled: number;
  version: number;
};

export class SqlDemandRepository implements DemandRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async findLine(lineId: string): Promise<ResolvedDemandLine | null> {
    const row = await this.database.first<LineRow>({
      sql: `SELECT l.id,l.line_name,l.enabled,l.voltage_level_id,
                   v.display_name AS voltage_name,v.enabled AS voltage_enabled
            FROM transmission_lines l
            JOIN voltage_levels v ON v.id=l.voltage_level_id
            WHERE l.id=? LIMIT 1`,
      params: [lineId],
    });
    return row ? {
      id: row.id,
      lineName: row.line_name,
      enabled: row.enabled === 1,
      voltageLevelId: row.voltage_level_id,
      voltageName: row.voltage_name,
      voltageEnabled: row.voltage_enabled === 1,
    } : null;
  }

  async findTowers(ids: readonly string[]): Promise<readonly ResolvedDemandTower[]> {
    if (!ids.length) return [];
    const rows = await this.database.all<TowerRow>({
      sql: `SELECT id,tower_no,sort_index,line_id,enabled
            FROM transmission_towers
            WHERE id IN (${ids.map(() => '?').join(',')})
            ORDER BY sort_index,id`,
      params: [...ids],
    });
    return rows.map((row) => ({
      id: row.id,
      towerNo: row.tower_no,
      sortIndex: row.sort_index,
      lineId: row.line_id,
      enabled: row.enabled === 1,
    }));
  }

  async findEnabledMaterials(ids: readonly string[]): Promise<readonly MaterialSummary[]> {
    if (!ids.length) return [];
    const rows = await this.database.all<MaterialRow>({
      sql: `SELECT id,code,name,model,unit,enabled,version
            FROM materials
            WHERE enabled=1 AND id IN (${ids.map(() => '?').join(',')})
            ORDER BY id`,
      params: [...ids],
    });
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      model: row.model,
      unit: row.unit,
      enabled: row.enabled === 1,
      version: row.version,
    }));
  }
}
