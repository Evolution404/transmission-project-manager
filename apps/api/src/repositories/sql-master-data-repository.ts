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
  physical_tower_id: string;
  physical_asset_code: string | null;
  tower_no: string;
  sort_rank: number;
  position_label: string | null;
  tower_type_id: string | null;
  tower_type_label: string | null;
  maintenance_team_id: string | null;
  maintenance_team_name: string | null;
  enabled: number;
  version: number;
  matched_historical_no: string | null;
};

type TeamRow = { id: string; code: string | null; name: string; enabled: number; version: number };
type TowerTypeRow = { id: string; code: string | null; label: string; sort_order: number; enabled: number; version: number };
type PhysicalTowerRow = {
  id: string;
  asset_code: string | null;
  tower_type_id: string | null;
  tower_type_label: string | null;
  maintenance_team_id: string | null;
  maintenance_team_name: string | null;
  enabled: number;
  version: number;
  custom_values_payload: string;
  custom_fields_version: number | null;
  line_position_count: number;
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
  line_tower_position_id: string;
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

function towerSummary(row: TowerRow): LineTowerPositionSummary {
  return {
    id: row.id,
    lineId: row.line_id,
    lineName: row.line_name,
    physicalTowerId: row.physical_tower_id,
    physicalAssetCode: row.physical_asset_code,
    towerNo: row.tower_no,
    sortRank: row.sort_rank,
    positionLabel: row.position_label,
    towerTypeId: row.tower_type_id,
    towerTypeLabel: row.tower_type_label,
    maintenanceTeamId: row.maintenance_team_id,
    maintenanceTeamName: row.maintenance_team_name,
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

  async listTeams(): Promise<readonly TeamSummary[]> {
    const rows = await this.database.all<TeamRow>({ sql: 'SELECT id,code,name,enabled,version FROM teams ORDER BY enabled DESC,name COLLATE NOCASE,id' });
    return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, enabled: Boolean(row.enabled), version: row.version }));
  }

  async listTowerTypes(): Promise<readonly TowerTypeSummary[]> {
    const rows = await this.database.all<TowerTypeRow>({ sql: 'SELECT id,code,label,sort_order,enabled,version FROM tower_types ORDER BY sort_order,label COLLATE NOCASE,id' });
    return rows.map((row) => ({ id: row.id, code: row.code, label: row.label, sortOrder: row.sort_order, enabled: Boolean(row.enabled), version: row.version }));
  }

  async listCustomFieldDefinitions(entityType: CustomFieldEntityType | null): Promise<readonly CustomFieldDefinitionSummary[]> {
    const rows = await this.database.all<{
      id: string; entity_type: CustomFieldDefinitionSummary['entityType']; field_key: string; label: string; data_type: CustomFieldDefinitionSummary['dataType'];
      required: number; filterable: number; options_json: string | null; validation_json: string;
      sort_order: number; enabled: number; version: number;
    }>({
      sql: `SELECT id,entity_type,field_key,label,data_type,required,filterable,options_json,validation_json,sort_order,enabled,version
            FROM custom_field_definitions
            ${entityType ? 'WHERE entity_type=?' : ''}
            ORDER BY entity_type,sort_order,field_key`,
      params: entityType ? [entityType] : [],
    });
    return rows.map((row) => ({
      id: row.id,
      entityType: row.entity_type,
      fieldKey: row.field_key,
      label: row.label,
      dataType: row.data_type,
      required: Boolean(row.required),
      filterable: Boolean(row.filterable),
      options: row.options_json ? JSON.parse(row.options_json) : null,
      validation: JSON.parse(row.validation_json || '{}') as Record<string, unknown>,
      sortOrder: row.sort_order,
      enabled: Boolean(row.enabled),
      version: row.version,
    }));
  }

  async getCustomFieldValues(entityType: CustomFieldEntityType, entityId: string): Promise<CustomFieldValueSetSummary> {
    const versionRow = await this.database.first<{ version: number }>({
      sql: 'SELECT version FROM custom_field_value_sets WHERE entity_type=? AND entity_id=? LIMIT 1',
      params: [entityType, entityId],
    });
    const rows = await this.database.all<{ field_key: string; value_json: string }>({
      sql: `SELECT d.field_key,v.value_json
            FROM custom_field_values v
            JOIN custom_field_definitions d ON d.id=v.field_definition_id
            WHERE v.entity_type=? AND v.entity_id=?
            ORDER BY d.sort_order,d.field_key`,
      params: [entityType, entityId],
    });
    return {
      entityType,
      entityId,
      version: versionRow ? Number(versionRow.version) : null,
      values: Object.fromEntries(rows.map((row) => [row.field_key, JSON.parse(row.value_json) as unknown])),
    };
  }

  async listPhysicalTowers(input: { query: string | null; limit: number }): Promise<readonly PhysicalTowerSummary[]> {
    const params: DatabaseValue[] = [];
    const where = input.query ? 'WHERE p.asset_code LIKE ? COLLATE NOCASE OR p.id=?' : '';
    if (input.query) params.push(`%${input.query}%`, input.query);
    const rows = await this.database.all<PhysicalTowerRow>({
      sql: `SELECT p.id,p.asset_code,p.tower_type_id,tt.label AS tower_type_label,
                   p.maintenance_team_id,tm.name AS maintenance_team_name,p.enabled,p.version,
                   COALESCE(cf.custom_values_payload,'{}') AS custom_values_payload,
                   cvs.version AS custom_fields_version,
                   COUNT(lp.id) AS line_position_count
            FROM physical_towers p
            LEFT JOIN tower_types tt ON tt.id=p.tower_type_id
            LEFT JOIN teams tm ON tm.id=p.maintenance_team_id
            LEFT JOIN line_tower_positions lp ON lp.physical_tower_id=p.id
            LEFT JOIN custom_field_value_sets cvs ON cvs.entity_type='physical_tower' AND cvs.entity_id=p.id
            LEFT JOIN (
              SELECT v.entity_id,json_group_object(d.field_key,json(v.value_json)) AS custom_values_payload
              FROM custom_field_values v
              JOIN custom_field_definitions d ON d.id=v.field_definition_id
              WHERE v.entity_type='physical_tower'
              GROUP BY v.entity_id
            ) cf ON cf.entity_id=p.id
            ${where}
            GROUP BY p.id,p.asset_code,p.tower_type_id,tt.label,p.maintenance_team_id,tm.name,p.enabled,p.version,cf.custom_values_payload,cvs.version
            ORDER BY COALESCE(p.asset_code,''),p.id LIMIT ?`,
      params: [...params, input.limit],
    });
    return rows.map((row) => ({
      id: row.id,
      assetCode: row.asset_code,
      towerTypeId: row.tower_type_id,
      towerTypeLabel: row.tower_type_label,
      maintenanceTeamId: row.maintenance_team_id,
      maintenanceTeamName: row.maintenance_team_name,
      enabled: Boolean(row.enabled),
      version: row.version,
      customValues: JSON.parse(row.custom_values_payload || '{}') as Record<string, unknown>,
      customFieldsVersion: row.custom_fields_version,
      linePositionCount: Number(row.line_position_count),
    }));
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
              FROM line_tower_positions
              GROUP BY line_id
            ) tc ON tc.line_id=l.id
            ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
            ORDER BY l.line_name COLLATE NOCASE,l.id LIMIT ?`,
      params: [...(queryPattern ? [queryPattern, queryPattern] : []), ...params, input.limit + 1],
    });
    return rows.map(lineSummary);
  }

  async listLineTowerPositions(input: { lineId: string | null; query: string | null; cursor: { sortRank: number; id: string } | null; limit: number }): Promise<readonly LineTowerPositionSummary[]> {
    const conditions: string[] = [];
    const params: DatabaseValue[] = [];
    if (input.lineId) {
      conditions.push('t.line_id=?');
      params.push(input.lineId);
    }
    if (input.query) {
      conditions.push(`(t.tower_no=? COLLATE NOCASE OR EXISTS (
        SELECT 1 FROM line_tower_position_no_history h
        WHERE h.line_tower_position_id=t.id AND h.tower_no=? COLLATE NOCASE
      ))`);
      params.push(input.query, input.query);
    }
    if (input.cursor) {
      conditions.push('(t.sort_rank>? OR (t.sort_rank=? AND t.id>?))');
      params.push(input.cursor.sortRank, input.cursor.sortRank, input.cursor.id);
    }
    const rows = await this.database.all<TowerRow>({
      sql: `SELECT t.id,t.line_id,t.physical_tower_id,p.asset_code AS physical_asset_code,t.tower_no,t.sort_rank,t.position_label,t.enabled,t.version,l.line_name,
                   p.tower_type_id,tt.label AS tower_type_label,p.maintenance_team_id,tm.name AS maintenance_team_name,
                   ${input.query ? `(CASE WHEN t.tower_no=? COLLATE NOCASE THEN NULL ELSE (
                     SELECT h.tower_no FROM line_tower_position_no_history h
                     WHERE h.line_tower_position_id=t.id AND h.tower_no=? COLLATE NOCASE
                     ORDER BY h.valid_to DESC,h.id DESC LIMIT 1
                   ) END)` : 'NULL'} AS matched_historical_no
            FROM line_tower_positions t
            JOIN transmission_lines l ON l.id=t.line_id
            JOIN physical_towers p ON p.id=t.physical_tower_id
            LEFT JOIN tower_types tt ON tt.id=p.tower_type_id
            LEFT JOIN teams tm ON tm.id=p.maintenance_team_id
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

  async listTowerPositionNoHistory(lineTowerPositionId: string): Promise<readonly LineTowerPositionNoHistoryEntry[]> {
    const rows = await this.database.all<TowerHistoryRow>({
      sql: `SELECT id,line_tower_position_id,line_id,tower_no,valid_from,valid_to,changed_by,change_reason
            FROM line_tower_position_no_history WHERE line_tower_position_id=? ORDER BY valid_to DESC,id DESC`,
      params: [lineTowerPositionId],
    });
    return rows.map((row) => ({
      id: row.id, lineTowerPositionId: row.line_tower_position_id, lineId: row.line_id, towerNo: row.tower_no,
      validFrom: row.valid_from, validTo: row.valid_to, changedBy: row.changed_by, reason: row.change_reason,
    }));
  }
}
