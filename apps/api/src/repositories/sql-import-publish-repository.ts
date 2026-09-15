import type { DatabasePort, DatabaseStatement } from '../ports/database.ts';
import type {
  CommitImportPublishInput,
  ExistingDemandBySignature,
  ExistingDemandBySource,
  ImportPublishRepository,
} from '../ports/import-publish-repository.ts';
import type { ImportValidationRow } from '../ports/import-validation-repository.ts';

type RowDb = {
  id: string;
  batch_id: string;
  chunk_index: number;
  sheet_name: string;
  source_row_number: number;
  source_key: string;
  raw_json: string;
  normalized_json: string | null;
  errors_json: string;
  warnings_json: string;
  row_status: ImportValidationRow['status'];
  published_demand_id: string | null;
};

function rowSummary(row: RowDb): ImportValidationRow {
  return {
    id: row.id,
    batchId: row.batch_id,
    chunkIndex: row.chunk_index,
    sheetName: row.sheet_name,
    rowNumber: row.source_row_number,
    sourceKey: row.source_key,
    rawJson: row.raw_json,
    normalizedJson: row.normalized_json,
    errorsJson: row.errors_json,
    warningsJson: row.warnings_json,
    status: row.row_status,
    publishedDemandId: row.published_demand_id,
  };
}

function gridGuard(input: CommitImportPublishInput['rows'][number]): DatabaseStatement {
  const item = input.normalized;
  return {
    sql: `INSERT INTO master_data_guards (id,invalid_grid_location) VALUES (1,CASE WHEN EXISTS (
            SELECT 1 FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id
            WHERE l.id=? AND v.id=? AND l.enabled=1 AND v.enabled=1 AND v.display_name=? AND l.line_name=?
            AND ((? IS NULL AND ? IS NULL AND ?='全线') OR EXISTS (
              SELECT 1 FROM line_tower_positions s JOIN line_tower_positions e ON e.line_id=s.line_id
              WHERE s.id=? AND e.id=? AND s.line_id=l.id AND s.enabled=1 AND e.enabled=1 AND s.sort_rank<=e.sort_rank
              AND (CASE WHEN s.id=e.id THEN s.tower_no ELSE s.tower_no || '—' || e.tower_no END)=?
            ))
          ) THEN 1 ELSE 0 END)
          ON CONFLICT(id) DO UPDATE SET invalid_grid_location=excluded.invalid_grid_location`,
    params: [
      item.lineId!, item.voltageLevelId!, item.voltageRaw, item.lineName,
      item.startTowerPositionId, item.endTowerPositionId, item.section,
      item.startTowerPositionId, item.endTowerPositionId, item.section,
    ],
  };
}

export class SqlImportPublishRepository implements ImportPublishRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async listValidRows(batchId: string, limit: number): Promise<readonly ImportValidationRow[]> {
    const rows = await this.database.all<RowDb>({
      sql: `SELECT id,batch_id,chunk_index,sheet_name,source_row_number,source_key,raw_json,normalized_json,errors_json,warnings_json,row_status,published_demand_id
            FROM import_rows WHERE batch_id=? AND row_status='valid' ORDER BY source_row_number,id LIMIT ?`,
      params: [batchId, limit],
    });
    return rows.map(rowSummary);
  }

  async findDemandIdsBySourceKeys(sourceKeys: readonly string[]): Promise<readonly ExistingDemandBySource[]> {
    if (!sourceKeys.length) return [];
    const placeholders = sourceKeys.map(() => '?').join(',');
    const rows = await this.database.all<{ source_key: string; demand_id: string }>({
      sql: `SELECT source_key,id AS demand_id FROM demands WHERE source_key IN (${placeholders})
            UNION ALL
            SELECT source_key,demand_id FROM demand_source_rows WHERE source_key IN (${placeholders})`,
      params: [...sourceKeys, ...sourceKeys],
    });
    return rows.map((row) => ({ sourceKey: row.source_key, demandId: row.demand_id }));
  }

  async findImportDemandIdsBySignatures(batchId: string, signatures: readonly string[]): Promise<readonly ExistingDemandBySignature[]> {
    if (!signatures.length) return [];
    const rows = await this.database.all<{ id: string; business_signature: string }>({
      sql: `SELECT id,business_signature FROM demands
            WHERE source_type='import' AND source_batch_id=?
              AND business_signature IN (${signatures.map(() => '?').join(',')})`,
      params: [batchId, ...signatures],
    });
    return rows.map((row) => ({ businessSignature: row.business_signature, demandId: row.id }));
  }

  async commitPublish(input: CommitImportPublishInput): Promise<void> {
    const statements: DatabaseStatement[] = [{
      sql: `INSERT INTO idempotency_records
            (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (
              ?,
              (SELECT ? WHERE EXISTS (
                SELECT 1 FROM import_batches WHERE id=? AND version=? AND status IN ('ready','publishing')
              )),
              ?,?,?,200,?
            )`,
      params: [input.idempotencyKey, input.actorId, input.batchId, input.expectedVersion, input.operation, input.requestHash, input.responseJson, input.now],
    }];

    for (const row of input.rows) {
      const normalized = row.normalized;
      statements.push(gridGuard(row));
      if (row.createDemand) {
        statements.push({
          sql: `INSERT INTO demands
                (id,source_type,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,
                 sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,
                 raw_json,extra_json,version,created_by,created_at,updated_at,voltage_level_id,line_id,location_type,start_tower_position_id,end_tower_position_id)
                VALUES (?,'import',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'{}',1,?,?,?,?,?,?,?,?)`,
          params: [
            row.demandId, row.sourceKey, input.batchId, input.fileSha256, input.fileName, row.sheetName, row.rowNumber,
            normalized.sequenceNo, normalized.year, normalized.voltageRaw, normalized.voltageVerified, normalized.lineName,
            normalized.section, normalized.category, normalized.owner, normalized.businessSignature, row.rawJson,
            input.actorId, input.now, input.now,
            normalized.voltageLevelId, normalized.lineId, normalized.locationType, normalized.startTowerPositionId, normalized.endTowerPositionId,
          ],
        });
      }
      statements.push({
        sql: `INSERT INTO demand_source_rows
              (id,demand_id,import_row_id,source_key,file_sha256,file_name,sheet_name,source_row_number,raw_json,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        params: [row.sourceRowId, row.demandId, row.rowId, row.sourceKey, input.fileSha256, input.fileName, row.sheetName, row.rowNumber, row.rawJson, input.now],
      });
      if (normalized.materialModel && normalized.quantityScaled !== null) {
        statements.push({
          sql: `INSERT INTO demand_materials
                (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at,source_import_row_id,created_by,version)
                VALUES (?,?,?,?,?,?,?,?,?,1)`,
          params: [row.materialRowId, row.demandId, normalized.materialModel, normalized.materialId, normalized.quantityScaled, normalized.unit, input.now, row.rowId, input.actorId],
        });
      }
      statements.push({
        sql: `UPDATE import_rows SET row_status='published',published_demand_id=?,updated_at=?
              WHERE id=? AND batch_id=? AND row_status='valid'`,
        params: [row.demandId, input.now, row.rowId, input.batchId],
      });
    }

    statements.push({
      sql: `UPDATE import_batches
            SET status=?,published_rows=?,published_at=?,version=version+1,updated_at=?
            WHERE id=? AND version=? AND status IN ('ready','publishing')`,
      params: [input.nextStatus, input.publishedRows, input.publishedAt, input.now, input.batchId, input.expectedVersion],
    }, {
      sql: `INSERT INTO audit_events
            (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,'import.publish','import_batch',?,?,?,?)`,
      params: [
        input.auditId,
        input.actorId,
        input.batchId,
        JSON.stringify({ publishedRows: input.beforePublishedRows }),
        input.responseJson,
        input.now,
      ],
    });
    const result = await this.database.batch(statements);
    if (result.at(-2)?.changes !== 1) throw new Error('IMPORT_VERSION_CONFLICT');
  }
}
