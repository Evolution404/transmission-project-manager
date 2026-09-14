import type { DictionaryItem, SettingVersion } from '@tpm/shared';
import type { DatabasePort } from '../ports/database';
import type {
  SettingWriteMetadata,
  SettingWriteRecord,
  SystemConfigRepository,
} from '../ports/system-config-repository';

type SettingRow = {
  id: string;
  setting_key: string;
  version: number;
  value_json: string;
  effective_from: string;
  created_by: string | null;
  created_at: string;
};

type DictionaryRow = {
  id: string;
  dictionary_key: string;
  item_key: string;
  label: string;
  value_json: string | null;
  enabled: number;
  sort_order: number;
  version: number;
};

function parseJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value) as unknown;
}

function settingSummary(row: SettingRow): SettingVersion {
  return {
    id: row.id,
    key: row.setting_key,
    version: Number(row.version),
    value: parseJson(row.value_json),
    effectiveFrom: row.effective_from,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function dictionarySummary(row: DictionaryRow): DictionaryItem {
  return {
    id: row.id,
    dictionaryKey: row.dictionary_key,
    itemKey: row.item_key,
    label: row.label,
    value: parseJson(row.value_json),
    enabled: Number(row.enabled) === 1,
    sortOrder: Number(row.sort_order),
    version: Number(row.version),
  };
}

export class SqlSystemConfigRepository implements SystemConfigRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async listCurrentSettings(): Promise<SettingVersion[]> {
    const rows = await this.database.all<SettingRow>({
      sql: `SELECT s.id,s.setting_key,s.version,s.value_json,s.effective_from,s.created_by,s.created_at
            FROM settings_versions s
            INNER JOIN (
              SELECT setting_key,MAX(version) AS version
              FROM settings_versions GROUP BY setting_key
            ) latest ON latest.setting_key=s.setting_key AND latest.version=s.version
            ORDER BY s.setting_key`,
    });
    return rows.map(settingSummary);
  }

  async getSettingHistory(key: string): Promise<SettingVersion[]> {
    const rows = await this.database.all<SettingRow>({
      sql: `SELECT id,setting_key,version,value_json,effective_from,created_by,created_at
            FROM settings_versions WHERE setting_key=? ORDER BY version DESC`,
      params: [key],
    });
    return rows.map(settingSummary);
  }

  async listDictionary(key?: string): Promise<DictionaryItem[]> {
    const rows = await this.database.all<DictionaryRow>(key
      ? {
          sql: `SELECT id,dictionary_key,item_key,label,value_json,enabled,sort_order,version
                FROM dictionary_items WHERE dictionary_key=? ORDER BY sort_order,item_key`,
          params: [key],
        }
      : {
          sql: `SELECT id,dictionary_key,item_key,label,value_json,enabled,sort_order,version
                FROM dictionary_items ORDER BY dictionary_key,sort_order,item_key`,
        });
    return rows.map(dictionarySummary);
  }

  async currentSettingVersion(key: string): Promise<number | null> {
    const row = await this.database.first<{ version: number }>({
      sql: `SELECT version FROM settings_versions WHERE setting_key=? ORDER BY version DESC LIMIT 1`,
      params: [key],
    });
    return row ? Number(row.version) : null;
  }

  async createSettingVersion(record: SettingWriteRecord, metadata: SettingWriteMetadata): Promise<void> {
    await this.database.batch([
      {
        sql: `INSERT INTO settings_versions
              (id,setting_key,version,value_json,effective_from,created_by,created_at)
              VALUES (?,?,?,?,?,?,?)`,
        params: [record.id, record.key, record.version, record.valueJson, record.effectiveFrom, record.createdBy, record.createdAt],
      },
      {
        sql: `INSERT INTO audit_events
              (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
              VALUES (?,?,'setting.version.create','setting',?,?,?,?)`,
        params: [metadata.auditId, metadata.actorId, record.key, metadata.beforeJson, metadata.afterJson, record.createdAt],
      },
      {
        sql: `INSERT INTO idempotency_records
              (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
              VALUES (?,?,?,?,?,?,?)`,
        params: [metadata.idempotencyKey, metadata.actorId, metadata.operation, metadata.requestHash, metadata.responseJson, metadata.statusCode, record.createdAt],
      },
    ]);
  }
}
