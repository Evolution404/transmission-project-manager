import type { CustomFieldEntityType } from '@tpm/shared';
import type { DatabasePort } from '../ports/database.ts';
import type {
  CommitCustomFieldValuesInput,
  CommitLineRenameInput,
  CommitMasterConfigInput,
  CommitPhysicalTowerUpdateInput,
  CommitSingleMasterDataInput,
  CommitTowerImportChunkInput,
  CommitTowerMoveInput,
  CommitTowerPhysicalRebindInput,
  CommitTowerReorderInput,
  CommitTowerRenameInput,
  MasterConfigKind,
  MasterDataWriteKind,
  MasterDataWriteRepository,
} from '../ports/master-data-write-repository.ts';
import {
  commitCustomFieldValues,
  commitMasterConfig,
  commitPhysicalTowerUpdate,
  commitTowerPhysicalRebind,
} from './master-data-write/master-config-write.ts';
import { commitSingleMasterData } from './master-data-write/single-master-write.ts';
import { customFieldEntityTables, masterConfigTables, masterDataTables } from './master-data-write/shared.ts';
import {
  commitLineRename,
  commitTowerImportChunk,
  commitTowerMove,
  commitTowerRename,
  commitTowerReorder,
} from './master-data-write/transmission-grid-write.ts';

export class SqlMasterDataWriteRepository implements MasterDataWriteRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async findRecord(kind: MasterDataWriteKind, id: string): Promise<Record<string, string | number | null> | null> {
    return this.database.first({ sql: `SELECT * FROM ${masterDataTables[kind]} WHERE id=? LIMIT 1`, params: [id] });
  }

  async findTowerRecords(ids: readonly string[]): Promise<readonly Record<string, string | number | null>[]> {
    if (!ids.length) return [];
    return this.database.all({
      sql: `SELECT * FROM line_tower_positions WHERE id IN (${ids.map(() => '?').join(',')})`,
      params: [...ids],
    });
  }

  async findPhysicalTower(id: string): Promise<Record<string, string | number | null> | null> {
    return this.database.first({ sql: 'SELECT * FROM physical_towers WHERE id=? LIMIT 1', params: [id] });
  }

  async findCustomFieldEntity(entityType: CustomFieldEntityType, id: string): Promise<Record<string, string | number | null> | null> {
    return this.database.first({ sql: `SELECT * FROM ${customFieldEntityTables[entityType]} WHERE id=? LIMIT 1`, params: [id] });
  }

  async findConfigRecord(kind: MasterConfigKind, id: string): Promise<Record<string, string | number | null> | null> {
    return this.database.first({ sql: `SELECT * FROM ${masterConfigTables[kind]} WHERE id=? LIMIT 1`, params: [id] });
  }

  async findVoltageParent(id: string): Promise<{ displayName: string; enabled: boolean } | null> {
    const row = await this.database.first<{ display_name: string; enabled: number }>({
      sql: 'SELECT display_name,enabled FROM voltage_levels WHERE id=? LIMIT 1',
      params: [id],
    });
    return row ? { displayName: row.display_name, enabled: row.enabled === 1 } : null;
  }

  async findTowerParent(lineId: string): Promise<{ lineName: string; enabled: boolean; voltageEnabled: boolean; towerOrderVersion: number } | null> {
    const row = await this.database.first<{ line_name: string; enabled: number; voltage_enabled: number; tower_order_version: number }>({
      sql: `SELECT l.line_name,l.enabled,l.tower_order_version,v.enabled AS voltage_enabled
            FROM transmission_lines l JOIN voltage_levels v ON v.id=l.voltage_level_id
            WHERE l.id=? LIMIT 1`,
      params: [lineId],
    });
    return row ? {
      lineName: row.line_name,
      enabled: row.enabled === 1,
      voltageEnabled: row.voltage_enabled === 1,
      towerOrderVersion: row.tower_order_version,
    } : null;
  }

  async listTowerOrder(lineId: string): Promise<readonly { id: string; towerNo: string; sortRank: number }[]> {
    const rows = await this.database.all<{ id: string; tower_no: string; sort_rank: number }>({
      sql: 'SELECT id,tower_no,sort_rank FROM line_tower_positions WHERE line_id=? ORDER BY sort_rank,id',
      params: [lineId],
    });
    return rows.map((row) => ({ id: row.id, towerNo: row.tower_no, sortRank: row.sort_rank }));
  }

  async countLineTowers(lineId: string): Promise<number> {
    const row = await this.database.first<{ total: number }>({
      sql: 'SELECT COUNT(*) AS total FROM line_tower_positions WHERE line_id=?',
      params: [lineId],
    });
    return Number(row?.total ?? 0);
  }

  commitSingle(input: CommitSingleMasterDataInput): Promise<void> {
    return commitSingleMasterData(this.database, input);
  }

  commitLineRename(input: CommitLineRenameInput): Promise<void> {
    return commitLineRename(this.database, input);
  }

  commitTowerRename(input: CommitTowerRenameInput): Promise<void> {
    return commitTowerRename(this.database, input);
  }

  commitTowerMove(input: CommitTowerMoveInput): Promise<void> {
    return commitTowerMove(this.database, input);
  }

  commitTowerImportChunk(input: CommitTowerImportChunkInput): Promise<void> {
    return commitTowerImportChunk(this.database, input);
  }

  commitTowerReorder(input: CommitTowerReorderInput): Promise<void> {
    return commitTowerReorder(this.database, input);
  }

  commitConfig(input: CommitMasterConfigInput): Promise<void> {
    return commitMasterConfig(this.database, input);
  }

  commitPhysicalTowerUpdate(input: CommitPhysicalTowerUpdateInput): Promise<void> {
    return commitPhysicalTowerUpdate(this.database, input);
  }

  commitTowerPhysicalRebind(input: CommitTowerPhysicalRebindInput): Promise<void> {
    return commitTowerPhysicalRebind(this.database, input);
  }

  commitCustomFieldValues(input: CommitCustomFieldValuesInput): Promise<void> {
    return commitCustomFieldValues(this.database, input);
  }
}
