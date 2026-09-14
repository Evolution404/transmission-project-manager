import type { MaterialSummary } from '@tpm/shared';
import type { DatabasePort, DatabaseStatement } from '../ports/database.ts';
import type { CreateStructuredDemandRecord, DemandRepository, ResolvedDemandLine, ResolvedDemandTower } from '../ports/demand-repository.ts';

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
  sort_rank: number;
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
      sql: `SELECT id,tower_no,sort_rank,line_id,enabled
            FROM transmission_towers
            WHERE id IN (${ids.map(() => '?').join(',')})
            ORDER BY sort_rank,id`,
      params: [...ids],
    });
    return rows.map((row) => ({
      id: row.id,
      towerNo: row.tower_no,
      sortRank: row.sort_rank,
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

  async createStructured(input: CreateStructuredDemandRecord): Promise<void> {
    const statements: DatabaseStatement[] = [{
      sql: `INSERT INTO idempotency_records
            (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (?,?,?,?,?,201,?)`,
      params: [input.idempotencyKey, input.actorId, input.operation, input.requestHash, input.responseJson, input.now],
    }, {
      sql: `INSERT INTO master_data_guards (id,invalid_grid_location) VALUES (1,CASE WHEN EXISTS (
              SELECT 1 FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id
              WHERE l.id=? AND v.id=? AND l.enabled=1 AND v.enabled=1 AND v.display_name=? AND l.line_name=?
              AND ((? IS NULL AND ? IS NULL AND ?='全线') OR EXISTS (
                SELECT 1 FROM transmission_towers s JOIN transmission_towers e ON e.line_id=s.line_id
                WHERE s.id=? AND e.id=? AND s.line_id=l.id AND s.enabled=1 AND e.enabled=1 AND s.sort_rank<=e.sort_rank
                AND (CASE WHEN s.id=e.id THEN s.tower_no ELSE s.tower_no || '—' || e.tower_no END)=?
              ))
            ) THEN 1 ELSE 0 END)
            ON CONFLICT(id) DO UPDATE SET invalid_grid_location=excluded.invalid_grid_location`,
      params: [
        input.lineId, input.voltageLevelId, input.voltageName, input.lineName,
        input.startTowerId, input.endTowerId, input.sectionText,
        input.startTowerId, input.endTowerId, input.sectionText,
      ],
    }, {
      sql: `INSERT INTO demands
            (id,source_type,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,
             sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,
             raw_json,extra_json,version,created_by,created_at,updated_at,voltage_level_id,line_id,location_type,start_tower_id,end_tower_id)
            VALUES (?,'manual',?,NULL,NULL,NULL,NULL,NULL,?,?,?,?,?,?,?,?,?,?,'{}',1,?,?,?,?,?,?,?,?)`,
      params: [
        input.id, input.sourceKey, input.sequenceNo, input.year, input.voltageName, input.voltageName,
        input.lineName, input.sectionText, input.category, input.owner, input.businessSignature, input.rawJson,
        input.actorId, input.now, input.now, input.voltageLevelId, input.lineId, input.locationType,
        input.startTowerId, input.endTowerId,
      ],
    }];

    const materialVersionEntries = Object.entries(input.materialVersions);
    if (materialVersionEntries.length) {
      statements.push({
        sql: `INSERT INTO master_data_guards (id,invalid_grid_location) VALUES (1,CASE WHEN NOT EXISTS (
                SELECT 1 FROM json_each(?) expected LEFT JOIN materials m ON m.id=expected.key
                WHERE m.id IS NULL OR m.enabled<>1 OR m.version<>CAST(expected.value AS INTEGER)
              ) THEN 1 ELSE 0 END)
              ON CONFLICT(id) DO UPDATE SET invalid_grid_location=excluded.invalid_grid_location`,
        params: [JSON.stringify(input.materialVersions)],
      });
    }
    if (input.materials.length) {
      statements.push({
        sql: `INSERT INTO demand_materials
              (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at,source_import_row_id,created_by,version)
              SELECT json_extract(value,'$.id'),?,json_extract(value,'$.rawModel'),json_extract(value,'$.materialId'),
                     CAST(json_extract(value,'$.quantityScaled') AS INTEGER),json_extract(value,'$.unit'),?,NULL,?,1
              FROM json_each(?)`,
        params: [input.id, input.now, input.actorId, JSON.stringify(input.materials)],
      });
    }
    statements.push({
      sql: `INSERT INTO audit_events
            (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,'demand.create.structured','demand',?,NULL,?,?)`,
      params: [input.auditId, input.actorId, input.id, JSON.stringify(input.auditAfter), input.now],
    });
    await this.database.batch(statements);
  }
}
