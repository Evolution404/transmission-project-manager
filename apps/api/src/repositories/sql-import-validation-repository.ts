import type { DatabasePort, DatabaseStatement, DatabaseValue } from '../ports/database.ts';
import type {
  CommitImportValidationInput,
  ImportLineLookup,
  ImportMaterialLookup,
  ImportTowerLookup,
  ImportValidationRepository,
  ImportValidationRow,
  ImportVoltageLookup,
} from '../ports/import-validation-repository.ts';

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

export class SqlImportValidationRepository implements ImportValidationRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async listUploadedRows(batchId: string, limit: number): Promise<readonly ImportValidationRow[]> {
    const rows = await this.database.all<RowDb>({
      sql: `SELECT id,batch_id,chunk_index,sheet_name,source_row_number,source_key,raw_json,normalized_json,errors_json,warnings_json,row_status,published_demand_id
            FROM import_rows WHERE batch_id=? AND row_status='uploaded' ORDER BY source_row_number,id LIMIT ?`,
      params: [batchId, limit],
    });
    return rows.map(rowSummary);
  }

  async findVoltageByName(displayName: string): Promise<ImportVoltageLookup | null> {
    const row = await this.database.first<{ id: string; display_name: string }>({
      sql: `SELECT id,display_name FROM voltage_levels
            WHERE enabled=1 AND display_name=? COLLATE NOCASE LIMIT 1`,
      params: [displayName],
    });
    return row ? { id: row.id, displayName: row.display_name } : null;
  }

  async findLineByName(voltageLevelId: string, lineName: string): Promise<ImportLineLookup | null> {
    const row = await this.database.first<{ id: string; line_name: string }>({
      sql: `SELECT id,line_name FROM transmission_lines
            WHERE enabled=1 AND voltage_level_id=? AND line_name=? COLLATE NOCASE LIMIT 1`,
      params: [voltageLevelId, lineName],
    });
    return row ? { id: row.id, lineName: row.line_name } : null;
  }

  async findTowersByNumbers(lineId: string, towerNos: readonly string[]): Promise<readonly ImportTowerLookup[]> {
    if (!towerNos.length) return [];
    const rows = await this.database.all<{ id: string; tower_no: string; sort_rank: number }>({
      sql: `SELECT id,tower_no,sort_rank FROM transmission_towers
            WHERE enabled=1 AND line_id=? AND tower_no COLLATE NOCASE IN (${towerNos.map(() => '?').join(',')})
            ORDER BY sort_rank,id`,
      params: [lineId, ...towerNos],
    });
    return rows.map((row) => ({ id: row.id, towerNo: row.tower_no, sortRank: row.sort_rank }));
  }

  async findMaterials(pairs: readonly { model: string; unit: string }[]): Promise<readonly ImportMaterialLookup[]> {
    if (!pairs.length) return [];
    const clauses: string[] = [];
    const params: DatabaseValue[] = [];
    for (const pair of pairs) {
      clauses.push('(model=? COLLATE NOCASE AND unit=? COLLATE NOCASE AND enabled=1)');
      params.push(pair.model, pair.unit);
    }
    const rows = await this.database.all<{ id: string; model: string; unit: string }>({
      sql: `SELECT id,model,unit FROM materials WHERE ${clauses.join(' OR ')}`,
      params,
    });
    return rows.map((row) => ({ id: row.id, model: row.model, unit: row.unit }));
  }

  async findExistingBusinessSignatures(signatures: readonly string[]): Promise<readonly string[]> {
    if (!signatures.length) return [];
    const rows = await this.database.all<{ business_signature: string }>({
      sql: `SELECT DISTINCT business_signature FROM demands
            WHERE business_signature IN (${signatures.map(() => '?').join(',')})`,
      params: [...signatures],
    });
    return rows.map((row) => row.business_signature);
  }

  async commitValidation(input: CommitImportValidationInput): Promise<void> {
    const statements: DatabaseStatement[] = [{
      sql: `INSERT INTO idempotency_records
            (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (
              ?,
              (SELECT ? WHERE EXISTS (
                SELECT 1 FROM import_batches WHERE id=? AND version=? AND status IN ('draft','validating')
              )),
              ?,?,?,200,?
            )`,
      params: [input.idempotencyKey, input.actorId, input.batchId, input.expectedVersion, input.operation, input.requestHash, input.responseJson, input.now],
    }];
    for (const row of input.rows) {
      statements.push({
        sql: `UPDATE import_rows
              SET normalized_json=?,errors_json=?,warnings_json=?,row_status=?,updated_at=?
              WHERE id=? AND batch_id=?`,
        params: [row.normalizedJson, row.errorsJson, row.warningsJson, row.status, input.now, row.id, input.batchId],
      });
    }
    statements.push({
      sql: `UPDATE import_batches
            SET status=?,valid_rows=?,error_rows=?,warning_rows=?,version=version+1,updated_at=?
            WHERE id=? AND version=? AND status IN ('draft','validating')`,
      params: [input.nextStatus, input.validRows, input.errorRows, input.warningRows, input.now, input.batchId, input.expectedVersion],
    });
    const result = await this.database.batch(statements);
    if (result.at(-1)?.changes !== 1) throw new Error('IMPORT_VERSION_CONFLICT');
  }
}
